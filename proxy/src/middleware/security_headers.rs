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
    let xfp = match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
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

/// Build the `Strict-Transport-Security` header value (GAP 3 — configurable
/// max-age, mirror Go `middleware.HSTSHeaders`). A non-positive max-age falls
/// back to the 63072000 (2y) default, matching Go's `if cfg.MaxAge <= 0`.
fn hsts_header_value(max_age: i64, preload: bool) -> String {
    let max_age = if max_age <= 0 { 63072000 } else { max_age };
    if preload {
        format!("max-age={max_age}; includeSubDomains; preload")
    } else {
        format!("max-age={max_age}; includeSubDomains")
    }
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
    // DirectTls is injected by the TLS-serving paths (tls::serve_manual /
    // serve_auto) — the Rust analogue of Go's `r.TLS != nil`. When this proxy
    // terminates TLS itself the handler has no other HTTPS signal, so HSTS would
    // never fire without it. Mirror Go isHTTPS's `r.TLS != nil || trusted-XFP`
    // OR-logic (GAP 1, SECURITY.md inv 10). The plain-HTTP path never injects it,
    // so a spoofed XFP from an untrusted source still cannot trigger HSTS.
    let direct_tls = request
        .extensions()
        .get::<crate::tls::DirectTls>()
        .is_some();
    let https = direct_tls
        || is_https(
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
    // Default-deny CSP, but let a handler set its own first (Go's SecurityHeaders
    // sets these BEFORE the handler runs, so a handler-set CSP wins there too).
    // The storage download serves untrusted uploads under CSP `sandbox`
    // (SECURITY.md invariant 28) — or_insert preserves it instead of clobbering.
    headers
        .entry(HeaderName::from_static("content-security-policy"))
        .or_insert(HeaderValue::from_static("default-src 'none'"));
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(API_PERMISSIONS_POLICY),
    );
    // HSTS (SECURITY.md invariant 10). Emitted ONLY on a demonstrably-HTTPS
    // request (direct TLS via DirectTls, or trusted-proxy XFP=https) — NEVER on
    // plain HTTP or from an untrusted XFP. max-age is configurable via
    // HSTS_MAX_AGE_SECONDS (GAP 3, default 63072000 = 2y); `preload` is
    // irreversible → opt-in only via HSTS_PRELOAD.
    if https {
        let value = hsts_header_value(state.config.hsts_max_age_seconds, state.config.hsts_preload);
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.insert(header::STRICT_TRANSPORT_SECURITY, v);
        }
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

/// Build the public-SPA Content-Security-Policy string. Mirror of Go
/// `middleware.PublicSecurityHeaders`'s CSP construction.
///
/// `allow_inline_scripts` adds `'unsafe-inline'` + `https://cdn.jsdelivr.net` to
/// `script-src` — off by default (strict). It is enabled only for legacy static
/// apps that rely on inline `<script>` blocks (e.g. the pg_reactive examples).
///
/// `csp_override` (env `CSP_POLICY`) replaces the computed policy verbatim when
/// non-empty.
pub fn build_public_csp(allow_inline_scripts: bool, csp_override: Option<&str>) -> String {
    if let Some(o) = csp_override {
        if !o.is_empty() {
            return o.to_string();
        }
    }
    let script_src = if allow_inline_scripts {
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
    } else {
        "script-src 'self'"
    };
    format!(
        "default-src 'self'; {script_src}; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
font-src 'self' data:; \
connect-src 'self' ws: wss:; \
worker-src 'self' blob:; \
object-src 'none'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'none'"
    )
}

/// Middleware applying the relaxed public-SPA security headers (mirror of Go
/// `PublicSecurityHeaders`). More permissive than the API headers but still
/// enforces frame protection and nosniff. Sets ONLY the four headers Go sets:
/// X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and the CSP.
pub async fn public_security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let csp = build_public_csp(
        state.config.public_allow_inline_scripts,
        state.config.csp_policy.as_deref(),
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
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if let Ok(v) = HeaderValue::from_str(&csp) {
        headers.insert(HeaderName::from_static("content-security-policy"), v);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirror of Go PublicSecurityHeaders: strict default has no inline scripts,
    // the inline-scripts opt-in adds 'unsafe-inline' + jsdelivr, and CSP_POLICY
    // overrides verbatim.
    #[test]
    fn public_csp_strict_and_relaxed() {
        let strict = build_public_csp(false, None);
        assert!(strict.contains("script-src 'self';"));
        assert!(
            !strict.contains("script-src 'self' 'unsafe-inline'"),
            "strict script-src has no inline scripts"
        );
        assert!(strict.contains("frame-ancestors 'none'"));
        assert!(strict.contains("connect-src 'self' ws: wss:"));

        let relaxed = build_public_csp(true, None);
        assert!(relaxed.contains("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"));

        // CSP_POLICY override replaces the whole policy.
        let overridden = build_public_csp(false, Some("default-src 'none'"));
        assert_eq!(overridden, "default-src 'none'");
        // Empty override is ignored.
        assert_eq!(build_public_csp(false, Some("")), strict);
    }

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

    // GAP 3: HSTS max-age is configurable; preload stays opt-in; a non-positive
    // value falls back to the 2y default (mirror Go HSTSHeaders' `MaxAge <= 0`).
    #[test]
    fn hsts_value_uses_configurable_max_age() {
        assert_eq!(
            hsts_header_value(31536000, false),
            "max-age=31536000; includeSubDomains"
        );
        assert_eq!(
            hsts_header_value(63072000, true),
            "max-age=63072000; includeSubDomains; preload"
        );
        // Non-positive → default 2y.
        assert_eq!(
            hsts_header_value(0, false),
            "max-age=63072000; includeSubDomains"
        );
        assert_eq!(
            hsts_header_value(-5, false),
            "max-age=63072000; includeSubDomains"
        );
    }
}
