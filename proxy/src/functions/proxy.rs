//! Shared reverse-proxy core for the `deno` and `http` edge-function runtimes.
//!
//! Port of the Go reference's `httputil.ReverseProxy` usage in
//! `proxy-go/functions/deno.go` + `http.go`. Both runtimes rewrite the request
//! path to `/functions/v1/{name}` on the target, strip any inbound
//! `X-Pgstack-*` identity headers, inject the caller's resolved identity, and
//! stream the upstream response back unchanged — so a container written for one
//! runtime works behind the other (wire-compatible).

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::error;
use url::Url;

use crate::middleware::rls::RequestClaims;

/// One long-lived reqwest client (connection pooling + bounded dial) shared
/// across every per-function reverse proxy — the analogue of Go's
/// `sharedUpstreamTransport`. Per-invocation deadlines are applied per request.
fn upstream_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(10)
            // Reverse proxies forward the path themselves; never follow 3xx
            // (an upstream redirect must reach the client verbatim).
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build upstream reverse-proxy client")
    })
}

/// Hop-by-hop headers that must not be forwarded in either direction (RFC 7230
/// §6.1), plus Host which reqwest sets from the target.
fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

/// Forward `body` to `target` at `/functions/v1/{fn_name}` (preserving `query`),
/// with the caller identity injected as `X-Pgstack-*` headers. Streams the
/// upstream response back. `timeout` of zero disables the per-request deadline
/// (only the client's connect timeout still applies).
#[allow(clippy::too_many_arguments)]
pub(super) async fn forward(
    target: &Url,
    fn_name: &str,
    method: Method,
    in_headers: &HeaderMap,
    query: Option<&str>,
    body: Bytes,
    claims: &RequestClaims,
    timeout: Duration,
) -> Response {
    // Build the upstream URL: scheme+authority from the target, path rewritten
    // to the edge-runtime convention, original query string preserved.
    let mut url = target.clone();
    url.set_path(&format!("/functions/v1/{fn_name}"));
    url.set_query(query);

    let mut req = upstream_client().request(method, url);
    if !timeout.is_zero() {
        req = req.timeout(timeout);
    }

    // Copy inbound headers except hop-by-hop and any forged X-Pgstack-* identity
    // headers (stripped here so a client cannot smuggle a role/sub/claims past
    // the proxy — they are re-set below from the resolved claims).
    let mut headers = HeaderMap::new();
    for (name, value) in in_headers.iter() {
        if is_hop_by_hop(name) {
            continue;
        }
        let lower = name.as_str();
        if lower == "x-pgstack-role" || lower == "x-pgstack-sub" || lower == "x-pgstack-claims" {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    inject_auth_headers(&mut headers, claims);

    let resp = match req.headers(headers).body(body).send().await {
        Ok(r) => r,
        Err(e) => {
            error!(fn = %fn_name, error = %e, "functions: upstream unreachable");
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "function upstream unreachable" })),
            )
                .into_response();
        }
    };

    // Mirror status + headers, stream the body unchanged.
    let status = resp.status();
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers().iter() {
        if is_hop_by_hop(name) {
            continue;
        }
        builder = builder.header(name, value);
    }
    match builder.body(Body::from_stream(resp.bytes_stream())) {
        Ok(r) => r,
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": "invalid upstream response" })),
        )
            .into_response(),
    }
}

/// Set the `X-Pgstack-*` identity headers on an outbound proxied request.
/// Shared by the `deno` and `http` runtimes (mirror Go `injectAuthHeaders`).
fn inject_auth_headers(headers: &mut HeaderMap, claims: &RequestClaims) {
    if let Ok(v) = HeaderValue::from_str(&claims.role) {
        headers.insert("x-pgstack-role", v);
    }
    let sub = claims.sub.as_deref().unwrap_or("");
    if let Ok(v) = HeaderValue::from_str(sub) {
        headers.insert("x-pgstack-sub", v);
    }
    if !claims.claims_json.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&claims.claims_json) {
            headers.insert("x-pgstack-claims", v);
        }
    }
}

/// Shared `client` accessor for the deno health probe (own short timeout).
pub(super) fn health_client() -> &'static reqwest::Client {
    upstream_client()
}
