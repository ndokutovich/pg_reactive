//! User static-file hosting from `PUBLIC_DIR`, with SPA fallback.
//!
//! Port of Go `routes/public.go` (`PublicSPA`). Mounted as the router's
//! lowest-priority fallback so it never shadows API/auth/rest routes — only
//! requests that match no other route reach it.
//!
//! Behaviour mirrored from Go:
//!   - Only GET/HEAD are served (others → 404).
//!   - Directory traversal is blocked lexically (a `..` that escapes the root
//!     → 404), and absolute / drive-letter / NUL paths are rejected.
//!   - A real sub-directory serves its own `index.html` (dir-index) when present.
//!   - A missing path WITH a file extension → 404 (missing asset).
//!   - A missing path WITHOUT an extension → root `index.html` (SPA route).
//!   - Cache-Control: `no-cache` for index.html, immutable 1y for hashed assets
//!     (`app.a1b2c3d4.js`), `max-age=3600` otherwise.

use std::path::{Component, Path, PathBuf};

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::state::AppState;

/// Fallback handler serving user static files from `PUBLIC_DIR` with SPA
/// fallback. Only mounted when `public_dir` is set and is an existing directory.
pub async fn serve_public(State(state): State<AppState>, req: Request) -> Response {
    let dir = match state.config.public_dir.as_deref() {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => return not_found(),
    };

    // Only GET and HEAD (mirror Go).
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return not_found();
    }

    let abs_dir = abs_path(&dir);
    let url_path = req.uri().path().trim_start_matches('/').to_string();

    let clean = match safe_static_path(&abs_dir, &url_path) {
        Some(p) => p,
        None => return not_found(),
    };
    let url_path_eff = if url_path.is_empty() {
        "index.html"
    } else {
        &url_path
    };

    match tokio::fs::metadata(&clean).await {
        Ok(m) if m.is_dir() => {
            // Real directory → serve its OWN index.html (dir-index) if present,
            // before any root SPA fallback.
            let dir_index = clean.join("index.html");
            if is_file(&dir_index).await {
                return serve_file(&dir_index, "index.html", req).await;
            }
            // No own index.html → fall through to SPA logic below.
        }
        Ok(_) => {
            // Regular file exists → serve it with cache headers keyed on its name.
            let fname = clean
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            return serve_file(&clean, &fname, req).await;
        }
        Err(_) => {} // Missing → SPA logic below.
    }

    // Missing file (or directory without its own index.html):
    //   extension present → missing asset → 404
    //   no extension       → SPA client-side route → root index.html
    if has_extension(url_path_eff) {
        return not_found();
    }
    let index = abs_dir.join("index.html");
    if is_file(&index).await {
        return serve_file(&index, "index.html", req).await;
    }
    not_found()
}

/// Serve a single resolved file via tower-http `ServeFile` (correct content-type
/// from the extension, range/HEAD handling), then attach the Cache-Control class
/// derived from `cache_filename` (the file actually served, not the URL).
async fn serve_file(path: &Path, cache_filename: &str, req: Request) -> Response {
    let svc = ServeFile::new(path);
    match svc.oneshot(req).await {
        Ok(resp) => {
            let mut resp = resp.map(axum::body::Body::new);
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_class(cache_filename)),
            );
            resp
        }
        Err(_) => not_found(),
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "404 page not found").into_response()
}

async fn is_file(p: &Path) -> bool {
    tokio::fs::metadata(p)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// Resolve `dir` to an absolute path without touching the filesystem (mirror of
/// Go's `filepath.Abs`). Relative dirs are joined onto the process CWD.
fn abs_path(dir: &str) -> PathBuf {
    let p = Path::new(dir);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}

/// Resolve `url_path` against `abs_dir`, guaranteeing the result stays inside
/// `abs_dir`. Returns `None` when the path is absolute, contains a drive letter,
/// a NUL byte, or a `..` that escapes the root. Shared traversal guard mirroring
/// Go's `safeStaticPath`.
fn safe_static_path(abs_dir: &Path, url_path: &str) -> Option<PathBuf> {
    let url_path = if url_path.is_empty() {
        "index.html"
    } else {
        url_path
    };
    // Reject leading separators (POSIX `/`, Windows `\`), absolute paths, NUL.
    if url_path.starts_with('/')
        || url_path.starts_with('\\')
        || Path::new(url_path).is_absolute()
        || url_path.contains('\0')
    {
        return None;
    }
    // Drive-letter sneak: `C:foo` is not absolute on POSIX but hostile on Windows.
    let b = url_path.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        return None;
    }

    // Lexically resolve the relative path; reject if any `..` escapes the root.
    let mut depth: i32 = 0;
    let mut rel = PathBuf::new();
    for comp in Path::new(url_path).components() {
        match comp {
            Component::Normal(seg) => {
                depth += 1;
                rel.push(seg);
            }
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
                rel.pop();
            }
            Component::CurDir => {}
            // RootDir / Prefix → an absolute sneak slipped past the checks above.
            _ => return None,
        }
    }
    Some(abs_dir.join(rel))
}

/// True when the last path segment contains a `.` — mirror of Go's
/// `filepath.Ext(urlPath) != ""`. Drives the SPA-fallback decision: a missing
/// path with an extension is a 404, without one it falls back to index.html.
fn has_extension(url_path: &str) -> bool {
    url_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .contains('.')
}

/// True when `filename` looks like a content-hashed bundle asset
/// (e.g. `app.a1b2c3d4.js`, `styles.EHI6WK3Q.css`): a dot-delimited segment of
/// ≥6 hex chars. Mirror of Go's `hashedAssetRe` (`\.[0-9a-fA-F]{6,}\.`).
fn is_hashed_asset(filename: &str) -> bool {
    let parts: Vec<&str> = filename.split('.').collect();
    if parts.len() < 3 {
        return false;
    }
    parts[1..parts.len() - 1]
        .iter()
        .any(|p| p.len() >= 6 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Cache-Control value for a served filename (mirror Go `setCacheHeaders`).
fn cache_class(filename: &str) -> &'static str {
    if filename == "index.html" {
        "no-cache"
    } else if is_hashed_asset(filename) {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\srv\public")
        } else {
            PathBuf::from("/srv/public")
        }
    }

    #[test]
    fn safe_path_allows_normal_files() {
        let r = root();
        assert_eq!(safe_static_path(&r, "style.css"), Some(r.join("style.css")));
        assert_eq!(
            safe_static_path(&r, "assets/app.js"),
            Some(r.join("assets").join("app.js"))
        );
        // Empty path → index.html.
        assert_eq!(safe_static_path(&r, ""), Some(r.join("index.html")));
        // Interior `..` that stays inside is allowed.
        assert_eq!(safe_static_path(&r, "a/../b.css"), Some(r.join("b.css")));
    }

    #[test]
    fn safe_path_blocks_traversal() {
        let r = root();
        assert_eq!(safe_static_path(&r, "../docker-compose.yml"), None);
        assert_eq!(safe_static_path(&r, "a/../../etc/passwd"), None);
        assert_eq!(safe_static_path(&r, "/etc/passwd"), None);
        assert_eq!(safe_static_path(&r, "\\etc\\passwd"), None);
        assert_eq!(safe_static_path(&r, "C:windows"), None);
        assert_eq!(safe_static_path(&r, "a\0b"), None);
    }

    #[test]
    fn extension_detection_drives_spa_fallback() {
        // No extension → SPA route → falls back to index.html.
        assert!(!has_extension("some/deep/spa/route"));
        assert!(!has_extension("dashboard"));
        assert!(!has_extension("users/42"));
        assert!(!has_extension("")); // root
                                     // Extension present → missing asset → 404.
        assert!(has_extension("missing.js"));
        assert!(has_extension("a/b/missing.css"));
        assert!(has_extension("file.tar.gz"));
        // Trailing-slash directory form has no extension.
        assert!(!has_extension("examples/apps/todo/"));
    }

    #[test]
    fn cache_class_matches_go() {
        assert_eq!(cache_class("index.html"), "no-cache");
        assert_eq!(
            cache_class("app.a1b2c3d4.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_class("main.deadbeef.css"),
            "public, max-age=31536000, immutable"
        );
        // Non-hashed assets → 1h.
        assert_eq!(cache_class("style.css"), "public, max-age=3600");
        assert_eq!(cache_class("logo.svg"), "public, max-age=3600");
        // Short hex (<6) is not treated as hashed.
        assert_eq!(cache_class("a.abc.js"), "public, max-age=3600");
        // Go's hashedAssetRe is hex-ONLY (`[0-9a-fA-F]{6,}`); a non-hex base32
        // hash like Vite's `EHI6WK3Q` is NOT matched → 1h (matches Go exactly,
        // despite Go's doc-comment listing it as an example).
        assert_eq!(cache_class("styles.EHI6WK3Q.css"), "public, max-age=3600");
    }

    #[test]
    fn hashed_asset_detection() {
        assert!(is_hashed_asset("app.a1b2c3d4.js"));
        assert!(is_hashed_asset("main.DEADBEEF.css"));
        assert!(!is_hashed_asset("index.html"));
        assert!(!is_hashed_asset("style.css"));
        assert!(!is_hashed_asset("a.xyz123.js")); // not all hex
    }
}
