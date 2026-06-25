//! runtime="http" — polyglot edge functions reverse-proxied to a per-function
//! upstream container.
//!
//! Port of the Go reference `proxy-go/functions/http.go`. The SSRF policy in
//! [`validate_upstream_url`] is the security-critical parity point (SECURITY.md
//! cross-cutting invariant #9): an `http`-runtime function carries its own
//! `upstream_url`, and without a strict guard a privileged caller (or a
//! compromised admin path) could point it at loopback, the cloud metadata
//! endpoint, or an arbitrary public host. The loopback NAME set is shared with
//! the webhook SSRF guard via [`crate::realtime::webhook_url::is_loopback_hostname`]
//! — the two surfaces do NOT duplicate the loopback knowledge.
//!
//! The deployment model is "the function is a sibling container on the docker
//! network", so the policy is intentionally the inverse of the webhook one:
//! http(s) only, host must be a BARE docker-network hostname — IP literals
//! rejected (blocks loopback/link-local/metadata in one rule), dotted FQDNs
//! rejected (a function cannot be pointed at an arbitrary public host), and the
//! reserved loopback names rejected explicitly.

use std::net::IpAddr;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use url::{Host, Url};

use crate::middleware::rls::RequestClaims;
use crate::realtime::webhook_url::is_loopback_hostname;

use super::catalog::FunctionMeta;
use super::proxy;

/// Enforce the SSRF policy for a runtime="http" upstream URL. Mirrors Go
/// `validateUpstreamURL` exactly (and is covered by the same cases as
/// `proxy-go/functions/http_validate_test.go`). Returns the parsed [`Url`] on
/// success; invalid rows are dropped from the catalog at refresh time so they
/// become a clean 404 rather than a live SSRF vector.
pub fn validate_upstream_url(raw: &str) -> Result<Url, String> {
    if raw.is_empty() {
        return Err("upstream_url is empty".into());
    }
    let u = Url::parse(raw).map_err(|e| format!("invalid upstream_url: {e}"))?;

    let scheme = u.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "upstream_url scheme must be http or https, got {scheme:?}"
        ));
    }

    let host = match u.host_str() {
        Some(h) if !h.is_empty() => h,
        _ => return Err("upstream_url has no host".into()),
    };

    // IP literals — rejected outright (blocks 127.0.0.1 / ::1, link-local
    // 169.254.169.254 metadata, RFC1918, and every other literal in one rule).
    if host.parse::<IpAddr>().is_ok()
        || matches!(u.host(), Some(Host::Ipv4(_)) | Some(Host::Ipv6(_)))
    {
        return Err(format!(
            "upstream_url host must be a docker-network hostname, not an IP literal ({host})"
        ));
    }

    // Dotted names — a bare docker-network hostname has no dot. Rejecting dotted
    // names keeps a function from being pointed at an arbitrary public FQDN.
    if host.contains('.') {
        return Err(format!(
            "upstream_url host must be a bare docker-network hostname, not a dotted name ({host})"
        ));
    }

    // The IP-literal rule above misses bare names the resolver special-cases to
    // loopback (`localhost`, `ip6-localhost`, ...) — reject those explicitly so a
    // function cannot loop back to the proxy itself (round 28 F3 / invariant 9).
    if is_loopback_hostname(host) {
        return Err(format!(
            "upstream_url host {host:?} resolves to loopback — refusing to target the proxy itself"
        ));
    }

    Ok(u)
}

/// Reverse-proxy to the function's own upstream container. The path rewrite and
/// identity injection are identical to the deno runtime (mirror Go
/// `proxyToUpstream`). The upstream was validated at catalog-refresh time, so a
/// row reaching here is already SSRF-clean; we re-validate defensively.
#[allow(clippy::too_many_arguments)]
pub async fn proxy_to_upstream(
    fm: &FunctionMeta,
    fn_name: &str,
    method: Method,
    headers: &HeaderMap,
    query: Option<&str>,
    body: Bytes,
    claims: &RequestClaims,
    timeout: Duration,
) -> Response {
    let target = match validate_upstream_url(&fm.upstream_url) {
        Ok(u) => u,
        Err(_) => {
            return super::json_error(
                axum::http::StatusCode::BAD_GATEWAY,
                "function upstream not available",
            );
        }
    };
    proxy::forward(
        &target, fn_name, method, headers, query, body, claims, timeout,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::validate_upstream_url;

    // Parity with proxy-go/functions/http_validate_test.go (round 28 F3 /
    // SECURITY.md invariant 9).

    #[test]
    fn accepts_docker_hostname() {
        for c in [
            "http://my-fn:8080",
            "http://my-fn:8080/v1/handler",
            "https://upstream-service",
        ] {
            assert!(validate_upstream_url(c).is_ok(), "want ok: {c}");
        }
    }

    #[test]
    fn rejects_loopback_bare_names() {
        for c in [
            "http://localhost",
            "http://localhost:8080",
            "https://LocalHost:9000/api",
            "http://localhost.localdomain:8080",
            "http://ip6-localhost",
            "http://ip6-loopback",
        ] {
            assert!(validate_upstream_url(c).is_err(), "want reject: {c}");
        }
    }

    #[test]
    fn rejects_ip_literals() {
        for c in [
            "http://127.0.0.1:8080",
            "http://0.0.0.0:8080",
            "http://169.254.169.254",
            "http://[::1]:8080",
        ] {
            assert!(validate_upstream_url(c).is_err(), "want reject: {c}");
        }
    }

    #[test]
    fn rejects_dotted_fqdn() {
        for c in ["http://attacker.example.com", "https://api.internal.corp"] {
            assert!(validate_upstream_url(c).is_err(), "want reject: {c}");
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        for c in ["file:///etc/passwd", "gopher://x:70/", "ftp://x"] {
            assert!(validate_upstream_url(c).is_err(), "want reject: {c}");
        }
    }

    #[test]
    fn rejects_empty() {
        assert!(validate_upstream_url("").is_err());
    }
}
