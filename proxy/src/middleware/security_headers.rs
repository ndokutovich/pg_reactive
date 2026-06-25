use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

/// Deny every powerful browser feature for API/SPA responses. An API origin
/// should never need camera/microphone/geolocation; an explicit denial means a
/// future XSS into a same-origin SPA can't use this origin as a launchpad.
/// Byte-identical to Go `middleware.apiPermissionsPolicy`.
const API_PERMISSIONS_POLICY: &str = "accelerometer=(), autoplay=(), camera=(), \
clipboard-read=(), clipboard-write=(), display-capture=(), \
encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), \
hid=(), idle-detection=(), magnetometer=(), microphone=(), \
midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), \
screen-wake-lock=(), serial=(), sync-xhr=(), usb=(), web-share=(), \
xr-spatial-tracking=()";

/// Whether the ORIGINAL client request demonstrably arrived over TLS.
///
/// This proxy terminates no TLS itself (it runs behind a TLS-terminating reverse
/// proxy), so the only HTTPS signal is `X-Forwarded-Proto` — honoured ONLY when
/// the immediate peer (`remote_ip`) is a configured trusted proxy. An untrusted
/// source's XFP is ignored entirely, defeating HSTS(-preload) poisoning via a
/// spoofed `X-Forwarded-Proto: https` against a directly-exposed proxy. Mirror of
/// Go `middleware.isHTTPS` (round-21 F4+F5, SECURITY.md inv 10).
fn is_https(headers: &HeaderMap, remote_ip: Option<IpAddr>, trusted_proxies: &str) -> bool {
    let xfp = match headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
        Some(v) => v,
        None => return false,
    };
    let remote = match remote_ip {
        Some(ip) => ip,
        None => return false,
    };
    let trusted = trusted_proxies
        .split(',')
        .filter_map(|s| s.trim().parse::<IpAddr>().ok())
        .any(|tp| tp == remote);
    trusted && xfp == "https"
}

/// Middleware that adds strict security headers to every API response.
pub async fn security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    // Capture the HTTPS signal BEFORE the request is consumed by the handler.
    let remote_ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    let https = is_https(
        request.headers(),
        remote_ip,
        state.config.trusted_proxies.as_deref().unwrap_or(""),
    );

    let mut response = next.run(request).await;

    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    // X-XSS-Protection: 0 disables the legacy auditor (known-bypassable); rely on
    // CSP instead. Mirror of Go SecurityHeaders.
    headers.insert(
        HeaderName::from_static("x-xss-protection"),
        HeaderValue::from_static("0"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(API_PERMISSIONS_POLICY),
    );
    // HSTS (SECURITY.md invariant 10). Emitted ONLY on a demonstrably-HTTPS
    // request (trusted-proxy XFP=https) — NEVER on plain HTTP or from an
    // untrusted XFP. `preload` is irreversible → opt-in only via HSTS_PRELOAD.
    if https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(if state.config.hsts_preload {
                "max-age=63072000; includeSubDomains; preload"
            } else {
                "max-age=63072000; includeSubDomains"
            }),
        );
    }

    response
}

/// Middleware that applies a relaxed CSP for Studio SPA paths and strict CSP
/// for all other paths. Studio needs `wasm-unsafe-eval` for Vite builds,
/// `unsafe-inline` styles for CSS-in-JS, and `ws:`/`wss:` for live queries.
pub async fn studio_security_headers(request: Request, next: Next) -> Response {
    let is_studio = request.uri().path().starts_with("/studio");

    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-xss-protection"),
        HeaderValue::from_static("0"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(API_PERMISSIONS_POLICY),
    );

    if is_studio {
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; \
                 script-src 'self' 'wasm-unsafe-eval'; \
                 style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data:; \
                 connect-src 'self' ws: wss:; \
                 frame-ancestors 'none'",
            ),
        );
    } else {
        headers.insert(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        );
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("default-src 'none'"),
        );
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                HeaderName::from_static(k),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    // SECURITY.md inv 10 (round-21 F4+F5): HSTS must be emitted only on a
    // demonstrably-HTTPS request, and XFP is honoured ONLY from a trusted proxy —
    // an untrusted source's spoofed `X-Forwarded-Proto: https` must NOT trigger
    // HSTS (defeating preload poisoning against a directly-exposed proxy). Mirror
    // of Go isHTTPS.
    #[test]
    fn hsts_only_on_https_from_trusted_proxy() {
        let trusted = "10.0.0.1, 10.0.0.2";
        let proxy: IpAddr = "10.0.0.1".parse().unwrap();
        let attacker: IpAddr = "203.0.113.9".parse().unwrap();

        // XFP=https from a trusted proxy → HTTPS.
        assert!(is_https(
            &hm(&[("x-forwarded-proto", "https")]),
            Some(proxy),
            trusted
        ));
        // XFP=https from an UNTRUSTED source → ignored (the poisoning vector).
        assert!(!is_https(
            &hm(&[("x-forwarded-proto", "https")]),
            Some(attacker),
            trusted
        ));
        // XFP=http from a trusted proxy → not HTTPS.
        assert!(!is_https(
            &hm(&[("x-forwarded-proto", "http")]),
            Some(proxy),
            trusted
        ));
        // No XFP at all → not HTTPS (plain HTTP, no HSTS).
        assert!(!is_https(&hm(&[]), Some(proxy), trusted));
        // No trusted proxies configured → XFP can never be trusted.
        assert!(!is_https(
            &hm(&[("x-forwarded-proto", "https")]),
            Some(proxy),
            ""
        ));
    }
}
