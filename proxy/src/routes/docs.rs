//! Bundled docs site (Docusaurus static build).
//!
//! Port of Go `routes/docs.go`. Served from `DOCS_DIR` (default `/docs`),
//! with `index.html` fallback for unmatched paths and per-directory
//! `index.html` for Docusaurus directory-style routes (handled by
//! `ServeDir.append_index_html_on_directories`, default on).
//!
//! Mounted with NO security-headers middleware — Docusaurus emits its own and
//! Go mounts `/docs` outside both the API and Studio middleware groups.

use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use tower_http::services::{ServeDir, ServeFile};

/// `GET /docs` → permanent redirect to `/docs/` so relative asset paths resolve.
///
/// Emits HTTP 301 (Moved Permanently) to match Go's `http.StatusMovedPermanently`
/// exactly — axum's `Redirect::permanent` would use 308.
pub async fn docs_redirect() -> impl IntoResponse {
    (
        StatusCode::MOVED_PERMANENTLY,
        [(header::LOCATION, "/docs/")],
    )
}

/// Serve the Docusaurus build from `DOCS_DIR` (default `/docs`), falling back to
/// the site `index.html` for unmatched paths. If the directory does not exist
/// (docs not built), the fallback yields 404 and the server still boots.
pub fn docs_service() -> ServeDir<ServeFile> {
    let dir = std::env::var("DOCS_DIR").unwrap_or_else(|_| "/docs".to_string());
    ServeDir::new(&dir).fallback(ServeFile::new(format!("{dir}/index.html")))
}
