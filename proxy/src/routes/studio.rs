use axum::response::Redirect;
use tower_http::services::{ServeDir, ServeFile};

/// Redirect bare /studio to /studio/ to fix relative asset paths.
pub async fn studio_redirect() -> Redirect {
    Redirect::permanent("/studio/")
}

/// Serve the Studio SPA from STUDIO_DIR env var (default: /studio).
/// Falls back to index.html for all unknown paths (SPA client-side routing).
pub fn studio_service() -> ServeDir<ServeFile> {
    let dir = std::env::var("STUDIO_DIR").unwrap_or_else(|_| "/studio".to_string());
    ServeDir::new(&dir).fallback(ServeFile::new(format!("{}/index.html", dir)))
}
