//! TLS serving (parity with the Go proxy's `TLS_MODE`: off / manual / auto).
//!
//! Mirrors Go `main.go`'s `startManualTLS` / `startAutoTLS`:
//!
//! - **off**    — plain HTTP on `listen_addr`. Handled inline in `main.rs`, not
//!   here, so the default path stays byte-for-byte what it was before TLS landed.
//! - **manual** — HTTPS on `https_addr` from the user's PEM cert+key files
//!   (`axum-server` + rustls). No redirect server (matches Go's manual mode).
//! - **auto**   — HTTPS on `https_addr` with ACME / Let's Encrypt certificates
//!   (`rustls-acme`) plus an HTTP->HTTPS 301 redirect server on `http_addr`
//!   (matches Go's auto-mode redirect).
//!
//! One deliberate, documented difference from Go: Go's `autocert` answers the
//! ACME **HTTP-01** challenge on `:80`, whereas `rustls-acme` answers
//! **TLS-ALPN-01** on `:443`. So the `:80` server here is redirect-only — it
//! carries no ACME challenge. Certificate issuance is otherwise equivalent.
//!
//! Fail-closed discipline: any cert/key load failure, or an unbindable address,
//! panics at boot. We never silently fall back to plaintext when TLS was asked
//! for. `Config::validate()` already rejects half-configured modes before we get
//! here; these are the runtime backstops.

use std::net::SocketAddr;

use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::Router;
use futures_util::StreamExt;
use rustls_acme::caches::DirCache;
use rustls_acme::AcmeConfig;
use tokio::net::TcpListener;
use tracing::{error, info};

use crate::config::Config;

/// Normalize a Go-style listen address into a Rust [`SocketAddr`]. A
/// leading-colon value (`:443`) binds all IPv4 interfaces, matching Go's `net`
/// package semantics; an explicit `host:port` is parsed as-is. Panics with a
/// clear message on an unparseable value — a TLS misconfig fails closed at boot.
fn normalize_addr(raw: &str, what: &str) -> SocketAddr {
    let candidate = match raw.strip_prefix(':') {
        Some(port) => format!("0.0.0.0:{port}"),
        None => raw.to_string(),
    };
    candidate
        .parse()
        .unwrap_or_else(|e| panic!("invalid {what}={raw:?}: {e}"))
}

/// Install the process-wide rustls crypto provider (ring). `axum-server` and
/// `rustls-acme` are built with the `*-no-provider` / pinned-`ring` features, so
/// the provider must be installed explicitly before any rustls `ServerConfig`
/// is constructed. Best-effort / idempotent (a second call is a no-op).
fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Spawn a task that turns Ctrl-C / SIGINT into a graceful shutdown of the
/// `axum-server` handle (no forced deadline — mirrors the off-mode
/// `with_graceful_shutdown`).
fn spawn_graceful_shutdown(handle: axum_server::Handle<SocketAddr>) {
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutdown signal received");
        handle.graceful_shutdown(None);
    });
}

/// HTTP->HTTPS redirect handler. Returns a `301 Moved Permanently` to the same
/// host+path over `https://` — matching Go's `httpToHTTPSRedirect`
/// (`http.StatusMovedPermanently`, i.e. 301, not axum's default 308).
async fn redirect_to_https(headers: HeaderMap, uri: Uri) -> impl IntoResponse {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let path = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let target = format!("https://{host}{path}");
    (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, target)])
}

/// Serve HTTPS in **manual** mode: load the user's PEM cert+key and serve over
/// rustls on `https_addr`. Mirror of Go `startManualTLS` (no redirect server).
pub async fn serve_manual(app: Router, config: &Config) {
    install_crypto_provider();
    let addr = normalize_addr(&config.https_addr, "HTTPS_ADDR");

    // validate() guarantees both are set in every environment; these expects are
    // the runtime backstop.
    let cert = config
        .tls_cert_file
        .as_ref()
        .expect("TLS_MODE=manual requires TLS_CERT_FILE (validated at startup)");
    let key = config
        .tls_key_file
        .as_ref()
        .expect("TLS_MODE=manual requires TLS_KEY_FILE (validated at startup)");

    // Fail closed: an unreadable/invalid cert or key aborts boot — never a
    // plaintext fallback when TLS was requested.
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
        .await
        .unwrap_or_else(|e| {
            panic!("TLS_MODE=manual: failed to load cert {cert:?} / key {key:?}: {e}")
        });

    let handle = axum_server::Handle::new();
    spawn_graceful_shutdown(handle.clone());

    info!(
        "pgstack-proxy listening on {} (HTTPS manual TLS, cert={})",
        addr, cert
    );
    axum_server::bind_rustls(addr, tls)
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("HTTPS server error");
}

/// Serve HTTPS in **auto** mode: obtain and renew certificates via ACME /
/// Let's Encrypt (`rustls-acme`, TLS-ALPN-01) on `https_addr`, and run an
/// HTTP->HTTPS 301 redirect server on `http_addr`. Mirror of Go `startAutoTLS`.
pub async fn serve_auto(app: Router, config: &Config) {
    install_crypto_provider();
    let https = normalize_addr(&config.https_addr, "HTTPS_ADDR");
    let http = normalize_addr(&config.http_addr, "HTTP_ADDR");

    // Build the ACME state. directory_lets_encrypt(true) selects the production
    // ACME directory (rustls-acme defaults to staging) — matching Go autocert,
    // which targets production Let's Encrypt.
    let mut acme = AcmeConfig::new(config.tls_domains.clone())
        .cache(DirCache::new(config.tls_cert_dir.clone()))
        .directory_lets_encrypt(true);
    if let Some(email) = &config.tls_acme_email {
        acme = acme.contact_push(format!("mailto:{email}"));
    }
    let mut state = acme.state();
    let rustls_config = state.default_rustls_config();
    let acceptor = state.axum_acceptor(rustls_config);

    // Drive ACME ordering + renewal in the background. The stream must be polled
    // for certificates to ever be issued/renewed.
    tokio::spawn(async move {
        loop {
            match state.next().await {
                Some(Ok(ok)) => info!("acme: {:?}", ok),
                Some(Err(err)) => error!("acme: {:?}", err),
                None => break,
            }
        }
    });

    // HTTP->HTTPS redirect server on :80 (mirror Go's auto-mode redirect). The
    // ACME challenge is TLS-ALPN-01 on :443, so :80 carries redirects only.
    let redirect = Router::new().fallback(redirect_to_https);
    tokio::spawn(async move {
        match TcpListener::bind(http).await {
            Ok(listener) => {
                info!("pgstack-proxy HTTP->HTTPS redirect on {}", http);
                if let Err(e) = axum::serve(listener, redirect.into_make_service()).await {
                    error!("HTTP redirect server error: {}", e);
                }
            }
            Err(e) => error!("HTTP redirect bind {} failed: {}", http, e),
        }
    });

    let handle = axum_server::Handle::new();
    spawn_graceful_shutdown(handle.clone());

    info!(
        "pgstack-proxy listening on {} (HTTPS auto-TLS / ACME, domains=[{}])",
        https,
        config.tls_domains.join(", ")
    );
    axum_server::bind(https)
        .handle(handle)
        .acceptor(acceptor)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("HTTPS server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_leading_colon_binds_all_interfaces() {
        assert_eq!(
            normalize_addr(":443", "HTTPS_ADDR"),
            "0.0.0.0:443".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn normalize_explicit_host_port_is_preserved() {
        assert_eq!(
            normalize_addr("127.0.0.1:8443", "HTTPS_ADDR"),
            "127.0.0.1:8443".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    #[should_panic(expected = "HTTPS_ADDR")]
    fn normalize_garbage_panics() {
        let _ = normalize_addr("not-an-address", "HTTPS_ADDR");
    }
}
