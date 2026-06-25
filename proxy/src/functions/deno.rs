//! runtime="deno" — reverse-proxy to the single global Deno edge-runtime
//! container (`EDGE_RUNTIME_URL`), plus the `/functions/v1/_health` readiness
//! probe.
//!
//! Port of the Go reference `proxy-go/functions/deno.go`. The invoke path
//! streams and is bound only by the per-invocation edge-fn deadline; the health
//! probe has its own short, dedicated timeout so a wedged Deno container cannot
//! leak a request task (gemini audit P2 — Go `denoHealthTimeout`).

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::warn;
use url::Url;

use crate::middleware::rls::RequestClaims;
use crate::state::AppState;

use super::proxy;

/// Health-probe deadline. A health check must be fast; 5s is generous and bounds
/// a Deno container that accepts the connection but never responds.
const DENO_HEALTH_TIMEOUT: Duration = Duration::from_secs(5);

/// Forward the request to the Deno edge-runtime with auth context injected.
/// Returns 503 when `EDGE_RUNTIME_URL` is unset (mirror Go `proxyToDeno`).
#[allow(clippy::too_many_arguments)]
pub async fn proxy_to_deno(
    edge_runtime_url: &str,
    fn_name: &str,
    method: Method,
    headers: &HeaderMap,
    query: Option<&str>,
    body: Bytes,
    claims: &RequestClaims,
    timeout: Duration,
) -> Response {
    if edge_runtime_url.is_empty() {
        return super::json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Deno runtime not configured (set EDGE_RUNTIME_URL)",
        );
    }
    let target = match Url::parse(edge_runtime_url) {
        Ok(u) => u,
        Err(_) => {
            return super::json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "edge runtime configuration error",
            );
        }
    };
    proxy::forward(&target, fn_name, method, headers, query, body, claims, timeout).await
}

/// GET /functions/v1/_health — proxy to the edge-runtime root as a readiness
/// check. Registered as a LITERAL route ahead of the `{name}` wildcard so it is
/// never shadowed by a function named "_health" (gemini audit P3). Returns 503
/// when `EDGE_RUNTIME_URL` is unset (mirror Go `DenoHealth`).
pub async fn deno_health(State(state): State<AppState>) -> Response {
    let url = &state.config.edge_runtime_url;
    if url.is_empty() {
        return super::json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Deno runtime not configured",
        );
    }
    let target = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => {
            return super::json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "edge runtime configuration error",
            );
        }
    };

    let resp = proxy::health_client()
        .get(target)
        .timeout(DENO_HEALTH_TIMEOUT)
        .send()
        .await;

    match resp {
        Ok(r) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "deno_runtime": "ok",
                "status_code": r.status().as_u16(),
            })),
        )
            .into_response(),
        Err(e) => {
            warn!(error = %e, "functions: deno health check failed");
            super::json_error(StatusCode::BAD_GATEWAY, "edge runtime unreachable")
        }
    }
}
