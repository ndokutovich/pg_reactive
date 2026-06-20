use std::time::Duration;

use axum::http::{header, HeaderName, HeaderValue, Method};
use tower_http::cors::CorsLayer;

/// Build CORS middleware.
///
/// When `allowed_origins` is `Some`, parses comma-separated origins and
/// restricts CORS to those values. When `None`, the layer is permissive ONLY if
/// `allow_permissive` (ALLOW_PERMISSIVE_CORS) is set — otherwise it is strict (no
/// Access-Control-Allow-Origin is emitted, so cross-origin browsers are blocked
/// while same-origin and non-browser clients still work). The production
/// validator additionally makes ALLOW_PERMISSIVE_CORS=true fatal.
pub fn cors_layer(allowed_origins: Option<&str>, allow_permissive: bool) -> CorsLayer {
    match allowed_origins {
        Some(origins) => {
            let parsed: Vec<HeaderValue> = origins
                .split(',')
                .filter_map(|o| o.trim().parse().ok())
                .collect();
            CorsLayer::new()
                .allow_origin(parsed)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    HeaderName::from_static("apikey"),
                    HeaderName::from_static("prefer"),
                ])
                .expose_headers([header::CONTENT_TYPE])
                .max_age(Duration::from_secs(3600))
        }
        None if allow_permissive => {
            // Dev opt-in: reflect any Origin.
            CorsLayer::very_permissive()
        }
        None => {
            // Strict default: emit no Access-Control-Allow-Origin.
            CorsLayer::new()
        }
    }
}
