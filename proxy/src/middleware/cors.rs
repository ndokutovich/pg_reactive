use tower_http::cors::{Any, CorsLayer};

/// Build CORS middleware that allows all origins (dev mode).
/// TODO: make configurable for production (allowed origins from env).
pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any)
}
