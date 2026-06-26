//! TLS serving (parity with the Go proxy's `TLS_MODE`: off / manual / auto).
//!
//! Mirrors Go `main.go`'s `startManualTLS` / `startAutoTLS`:
//!
//! - **off**    — plain HTTP on `listen_addr` via `serve_plain` (axum-server), so
//!   the same HTTP timeout knobs + bounded graceful-shutdown apply; no `DirectTls`
//!   marker is injected, so HSTS never fires over plaintext.
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
use std::time::Duration;

use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::{Extension, Router};
use futures_util::StreamExt;
use hyper_util::rt::TokioTimer;
use rustls_acme::caches::DirCache;
use rustls_acme::AcmeConfig;
use tokio::net::TcpListener;
use tracing::{error, info};

use crate::config::Config;

/// Request-extension marker injected by the TLS-serving paths (`serve_manual` /
/// `serve_auto`) onto every request they handle. It is the Rust analogue of Go's
/// `r.TLS != nil`: when this proxy terminates TLS itself the axum handler sees
/// only `ConnectInfo<SocketAddr>` and no TLS signal, so the security-headers
/// middleware would never fire HSTS on a directly-TLS-served request. The
/// middleware treats the presence of this marker exactly like Go's `r.TLS != nil`
/// (HSTS fires) — OR'd with the trusted-proxy `X-Forwarded-Proto: https` path.
///
/// The plain-HTTP `serve_plain` path deliberately does NOT inject it, so HSTS is
/// never emitted over plaintext, and a spoofed `X-Forwarded-Proto` from an
/// untrusted source still cannot trigger it (SECURITY.md inv 10).
#[derive(Clone, Copy)]
pub struct DirectTls;

/// Apply the HTTP-server timeout knobs (GAP 2, mirror Go http.Server
/// ReadTimeout / IdleTimeout) to an axum-server HTTP builder:
///   - `read_timeout` → hyper's HTTP/1 header-read deadline (slow-loris defense,
///     like Go's per-connection ReadTimeout); a Tokio timer is installed so the
///     deadline can fire. 0 disables it.
///   - `idle_timeout` → HTTP/2 keep-alive PING interval+timeout, the closest
///     hyper equivalent to Go's IdleTimeout. HTTP/1 has no numeric idle-keepalive
///     knob in hyper, so for HTTP/1 keep-alive stays enabled (Go-style reuse) and
///     the active per-request bound is the WRITE_TIMEOUT `TimeoutLayer` in
///     `build_router`. 0 leaves HTTP/2 keep-alive at hyper's default.
///
/// Write/shutdown timeouts are applied elsewhere (TimeoutLayer and the
/// graceful-shutdown deadline respectively).
macro_rules! apply_http_timeouts {
    ($server:expr, $config:expr) => {{
        let read =
            ($config.read_timeout_secs > 0).then(|| Duration::from_secs($config.read_timeout_secs));
        let idle =
            ($config.idle_timeout_secs > 0).then(|| Duration::from_secs($config.idle_timeout_secs));
        let b = $server.http_builder();
        b.http1()
            .timer(TokioTimer::new())
            .header_read_timeout(read)
            .keep_alive(true);
        let mut h2 = b.http2();
        h2.timer(TokioTimer::new());
        if let Some(idle) = idle {
            h2.keep_alive_interval(idle).keep_alive_timeout(idle);
        }
    }};
}

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
/// `axum-server` handle, bounded by `shutdown_timeout_secs` (GAP 2 — mirror Go's
/// `srv.Shutdown(ctx)` with `cfg.ShutdownTimeout`). A value of 0 means "no
/// forced deadline" (drain indefinitely); otherwise in-flight connections are
/// force-closed once the deadline elapses.
fn spawn_graceful_shutdown(handle: axum_server::Handle<SocketAddr>, shutdown_timeout_secs: u64) {
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutdown signal received");
        let deadline =
            (shutdown_timeout_secs > 0).then(|| Duration::from_secs(shutdown_timeout_secs));
        handle.graceful_shutdown(deadline);
    });
}

/// Serve plain HTTP (`TLS_MODE=off`) through axum-server so the same HTTP
/// timeout knobs and bounded graceful-shutdown apply as on the TLS paths (GAP 2).
/// Functionally identical to the previous `axum::serve` path (plain HTTP on
/// `listen_addr`, per-connection `ConnectInfo<SocketAddr>`), but it does NOT
/// inject `DirectTls`, so HSTS never fires over plaintext.
pub async fn serve_plain(app: Router, config: &Config) {
    let addr = config.listen_addr;
    let mut server = axum_server::bind(addr);
    apply_http_timeouts!(server, config);

    let handle = axum_server::Handle::new();
    spawn_graceful_shutdown(handle.clone(), config.shutdown_timeout_secs);

    info!(
        "pgstack-proxy listening on {} (HTTP, max_connections={})",
        addr, config.max_connections
    );
    server
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("server error");
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

    // Inject the DirectTls marker: this server terminates TLS itself, so every
    // request it serves is the analogue of Go's `r.TLS != nil` and HSTS must fire
    // (security_headers reads this extension). GAP 1.
    let app = app.layer(Extension(DirectTls));

    let handle = axum_server::Handle::new();
    spawn_graceful_shutdown(handle.clone(), config.shutdown_timeout_secs);

    info!(
        "pgstack-proxy listening on {} (HTTPS manual TLS, cert={})",
        addr, cert
    );
    let mut server = axum_server::bind_rustls(addr, tls);
    apply_http_timeouts!(server, config);
    server
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("HTTPS server error");
}

/// Serve HTTPS in **auto** mode: obtain and renew certificates via ACME /
/// Let's Encrypt (`rustls-acme`, TLS-ALPN-01) on `https_addr`, and run an
/// HTTP->HTTPS 301 redirect server on `http_addr`. Mirror of Go `startAutoTLS`.
///
/// GAP 4 — documented operational difference from the Go proxy (NOT drop-in
/// identical): Go's `autocert` answers the ACME **HTTP-01** challenge on `:80`
/// (`m.HTTPHandler`), so issuance needs inbound `:80`. `rustls-acme` here answers
/// **TLS-ALPN-01** on `:443` instead, so issuance needs inbound `:443` and the
/// `:80` server below is redirect-ONLY (it carries no ACME challenge). Both are
/// valid RFC 8555 methods and certificate issuance is otherwise equivalent;
/// TLS-ALPN-01 is arguably preferable (no plaintext :80 dependency). Operators
/// fronting the proxy with a firewall must allow inbound `:443` for renewal, not
/// (only) `:80`. This is left as-is intentionally — see SECURITY.md / env docs.
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
    // Inject the DirectTls marker (GAP 1): the ACME path terminates TLS on :443,
    // so HSTS must fire just like Go's auto-TLS server.
    let app = app.layer(Extension(DirectTls));

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
    spawn_graceful_shutdown(handle.clone(), config.shutdown_timeout_secs);

    info!(
        "pgstack-proxy listening on {} (HTTPS auto-TLS / ACME, domains=[{}])",
        https,
        config.tls_domains.join(", ")
    );
    let mut server = axum_server::bind(https).acceptor(acceptor);
    apply_http_timeouts!(server, config);
    server
        .handle(handle)
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
