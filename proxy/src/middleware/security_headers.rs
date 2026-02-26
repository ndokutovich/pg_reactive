use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

/// Middleware that adds strict security headers to every API response.
pub async fn security_headers(request: Request, next: Next) -> Response {
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
