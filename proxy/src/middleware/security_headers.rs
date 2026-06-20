use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

/// Middleware that adds strict security headers to every API response.
pub async fn security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
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
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'"),
    );
    // HSTS (SECURITY.md invariant 10). `preload` is irreversible → opt-in only
    // via HSTS_PRELOAD. Honoured by browsers only over HTTPS; harmless over plain
    // HTTP behind a TLS-terminating reverse proxy.
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static(if state.config.hsts_preload {
            "max-age=63072000; includeSubDomains; preload"
        } else {
            "max-age=63072000; includeSubDomains"
        }),
    );

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
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
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
