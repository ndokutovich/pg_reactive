use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use hyper::body::Incoming;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, RwLock, Semaphore};
use tracing::{error, info, warn};

/// Per-channel broadcast sender. One PG LISTEN channel -> N WebSocket clients.
type Channels = Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>;

/// JWT claims (minimal — sub is the only required field).
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct Claims {
    sub: String,
    #[serde(default)]
    exp: Option<u64>,
}

/// Shared app state including optional JWT secret.
#[derive(Clone)]
struct AppState {
    channels: Channels,
    jwt_secret: Option<String>,
    pg_connected: Arc<AtomicBool>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pg_reactive_proxy=info".into()),
        )
        .init();

    let pg_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@db:5432/pg_reactive_test".into());
    let listen_addr: SocketAddr = std::env::var("LISTEN_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()
        .expect("invalid LISTEN_ADDR");

    let jwt_secret = std::env::var("JWT_SECRET").ok();
    if jwt_secret.is_some() {
        info!("JWT authentication enabled");
    } else {
        warn!("JWT_SECRET not set — authentication disabled");
    }

    let channels: Channels = Arc::new(RwLock::new(HashMap::new()));
    let pg_connected = Arc::new(AtomicBool::new(false));
    let state = AppState {
        channels: channels.clone(),
        jwt_secret,
        pg_connected: pg_connected.clone(),
    };

    // Spawn the PG LISTEN task
    let pg_channels = channels.clone();
    let pg_url_clone = pg_url.clone();
    tokio::spawn(async move {
        pg_listener_loop(&pg_url_clone, pg_channels, pg_connected).await;
    });

    // Start the HTTP/WebSocket server
    let max_connections: usize = std::env::var("MAX_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10000);
    let semaphore = Arc::new(Semaphore::new(max_connections));

    let listener = TcpListener::bind(listen_addr)
        .await
        .expect("failed to bind");
    info!(
        "pg_reactive proxy listening on {} (max_connections={})",
        listen_addr, max_connections
    );

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                error!("accept error: {}", e);
                continue;
            }
        };

        let permit = match semaphore.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                warn!("connection limit reached, rejecting {}", addr);
                drop(stream);
                continue;
            }
        };

        let state = state.clone();
        tokio::spawn(async move {
            handle_connection(stream, addr, state).await;
            drop(permit);
        });
    }
}

/// Connects to PG and listens on `pgr` channel, dispatching to broadcast channels.
/// Uses exponential backoff on connection failures (1s -> 2s -> 4s -> ... -> 30s max).
async fn pg_listener_loop(pg_url: &str, channels: Channels, pg_connected: Arc<AtomicBool>) {
    let mut backoff_secs: u64 = 1;
    loop {
        pg_connected.store(false, Ordering::Relaxed);
        match pg_listener_run(pg_url, &channels, &pg_connected).await {
            Ok(()) => {
                info!("PG listener exited normally, reconnecting...");
                backoff_secs = 1; // reset on clean exit
            }
            Err(e) => {
                error!("PG listener error: {}, reconnecting in {}s...", e, backoff_secs);
            }
        }
        pg_connected.store(false, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn pg_listener_run(
    pg_url: &str,
    channels: &Channels,
    pg_connected: &AtomicBool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut listener = sqlx::postgres::PgListener::connect(pg_url).await?;
    // Listen on the wildcard channel that pg_reactive uses
    // pg_reactive sends NOTIFY on channel "pgr" with JSON payload containing query_id
    listener.listen("pgr").await?;
    pg_connected.store(true, Ordering::Relaxed);
    info!("connected to PG, listening on channel 'pgr'");

    loop {
        let notification = listener.recv().await?;
        let payload = notification.payload();

        // Parse the payload to extract query_id
        let msg: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(e) => {
                warn!("invalid JSON from PG NOTIFY: {}: {}", e, payload);
                continue;
            }
        };

        let query_id = match msg.get("query_id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => {
                warn!("NOTIFY payload missing query_id: {}", payload);
                continue;
            }
        };

        // Dispatch to the broadcast channel for this query_id
        let channels_read = channels.read().await;
        if let Some(tx) = channels_read.get(&query_id) {
            let _ = tx.send(payload.to_string());
        }
    }
}

/// Extract JWT token from request: query param `?token=xxx` or `Authorization: Bearer xxx`.
fn extract_token(req: &Request<Incoming>) -> Option<String> {
    // Check query parameter first
    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(token) = pair.strip_prefix("token=") {
                return Some(token.to_string());
            }
        }
    }

    // Check Authorization header
    if let Some(auth) = req.headers().get(hyper::header::AUTHORIZATION) {
        if let Ok(auth_str) = auth.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    None
}

/// Validate JWT token against the configured secret.
fn validate_jwt(token: &str, secret: &str) -> Result<Claims, String> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    // Allow tokens without exp claim for flexibility
    validation.required_spec_claims.remove("exp");
    validation.validate_exp = false;

    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("JWT validation failed: {}", e))
}

/// Handle a TCP connection: health check or WebSocket upgrade.
async fn handle_connection(stream: tokio::net::TcpStream, addr: SocketAddr, state: AppState) {
    let io = TokioIo::new(stream);

    let service = hyper::service::service_fn(move |req: Request<Incoming>| {
        let state = state.clone();
        async move { handle_request(req, addr, state).await }
    });

    if let Err(e) = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await
    {
        if !e.to_string().contains("early eof") {
            error!("connection error from {}: {}", addr, e);
        }
    }
}

async fn handle_request(
    req: Request<Incoming>,
    addr: SocketAddr,
    state: AppState,
) -> Result<Response<http_body_util::Full<hyper::body::Bytes>>, hyper::Error> {
    let path = req.uri().path().to_string();

    match path.as_str() {
        "/health" => {
            let pg_ok = state.pg_connected.load(Ordering::Relaxed);
            let status = if pg_ok { "ok" } else { "degraded" };
            let code = if pg_ok { 200 } else { 503 };
            let body = format!(
                r#"{{"status":"{}","pg_connected":{}}}"#,
                status, pg_ok
            );
            Ok(Response::builder()
                .status(code)
                .body(http_body_util::Full::new(hyper::body::Bytes::from(body)))
                .unwrap())
        }

        _ if path.starts_with("/ws/") => {
            // Extract query_id from path: /ws/{query_id}
            let query_id = path.trim_start_matches("/ws/").to_string();
            if query_id.is_empty() {
                return Ok(Response::builder()
                    .status(400)
                    .body(http_body_util::Full::new(hyper::body::Bytes::from(
                        r#"{"error":"missing query_id"}"#,
                    )))
                    .unwrap());
            }

            // JWT authentication (if secret is configured)
            if let Some(ref secret) = state.jwt_secret {
                match extract_token(&req) {
                    Some(token) => {
                        match validate_jwt(&token, secret) {
                            Ok(claims) => {
                                info!("authenticated WebSocket: sub={} query_id={}", claims.sub, query_id);
                            }
                            Err(e) => {
                                warn!("JWT auth failed from {}: {}", addr, e);
                                return Ok(Response::builder()
                                    .status(401)
                                    .body(http_body_util::Full::new(hyper::body::Bytes::from(
                                        r#"{"error":"invalid token"}"#,
                                    )))
                                    .unwrap());
                            }
                        }
                    }
                    None => {
                        warn!("missing JWT token from {}", addr);
                        return Ok(Response::builder()
                            .status(401)
                            .body(http_body_util::Full::new(hyper::body::Bytes::from(
                                r#"{"error":"authentication required"}"#,
                            )))
                            .unwrap());
                    }
                }
            }

            // Check for WebSocket upgrade
            if !hyper_tungstenite_upgrade::is_upgrade_request(&req) {
                return Ok(Response::builder()
                    .status(400)
                    .body(http_body_util::Full::new(hyper::body::Bytes::from(
                        r#"{"error":"expected websocket upgrade"}"#,
                    )))
                    .unwrap());
            }

            // Perform the upgrade
            let (response, ws_future) = match hyper_tungstenite_upgrade::upgrade(req)
            {
                Ok(pair) => pair,
                Err(e) => {
                    warn!("websocket upgrade failed from {}: {}", addr, e);
                    return Ok(Response::builder()
                        .status(400)
                        .body(http_body_util::Full::new(hyper::body::Bytes::from(
                            r#"{"error":"websocket upgrade failed"}"#,
                        )))
                        .unwrap());
                }
            };

            let channels = state.channels.clone();
            tokio::spawn(async move {
                match ws_future.await {
                    Ok(ws_stream) => {
                        handle_websocket(ws_stream, addr, query_id, channels).await;
                    }
                    Err(e) => error!("websocket upgrade error from {}: {}", addr, e),
                }
            });

            Ok(response.map(|_| http_body_util::Full::new(hyper::body::Bytes::new())))
        }

        _ => Ok(Response::builder()
            .status(404)
            .body(http_body_util::Full::new(hyper::body::Bytes::from(
                r#"{"error":"not found"}"#,
            )))
            .unwrap()),
    }
}

/// Handle an established WebSocket connection for a given query_id.
async fn handle_websocket(
    ws_stream: tokio_tungstenite::WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>,
    addr: SocketAddr,
    query_id: String,
    channels: Channels,
) {
    info!("WebSocket connected: {} -> query_id={}", addr, query_id);

    // Subscribe to the broadcast channel for this query_id
    let mut rx = {
        let mut channels_write = channels.write().await;
        let tx = channels_write
            .entry(query_id.clone())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(1024);
                tx
            });
        tx.subscribe()
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Send a welcome message
    let welcome = serde_json::json!({
        "type": "subscribed",
        "query_id": query_id,
    });
    if let Err(e) = ws_tx
        .send(tokio_tungstenite::tungstenite::Message::Text(
            welcome.to_string().into(),
        ))
        .await
    {
        error!("failed to send welcome to {}: {}", addr, e);
        return;
    }

    loop {
        tokio::select! {
            // Forward PG NOTIFY messages to WebSocket client
            msg = rx.recv() => {
                match msg {
                    Ok(payload) => {
                        if let Err(e) = ws_tx.send(
                            tokio_tungstenite::tungstenite::Message::Text(payload.into())
                        ).await {
                            info!("WebSocket send error to {}: {}", addr, e);
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("client {} lagged by {} messages, sending overflow", addr, n);
                        let overflow = serde_json::json!({
                            "type": "overflow",
                            "query_id": query_id,
                            "fetch": true,
                        });
                        let _ = ws_tx.send(
                            tokio_tungstenite::tungstenite::Message::Text(
                                overflow.to_string().into(),
                            )
                        ).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        info!("broadcast channel closed for {}", addr);
                        break;
                    }
                }
            }

            // Handle incoming WebSocket messages (ping/pong, close)
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                        info!("WebSocket disconnected: {} (query_id={})", addr, query_id);
                        break;
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(data))) => {
                        let _ = ws_tx.send(
                            tokio_tungstenite::tungstenite::Message::Pong(data)
                        ).await;
                    }
                    Some(Ok(_)) => {} // ignore other messages
                    Some(Err(e)) => {
                        info!("WebSocket error from {}: {}", addr, e);
                        break;
                    }
                }
            }
        }
    }

    // Clean up broadcast channel if no more subscribers
    {
        let mut channels_write = channels.write().await;
        if let Some(tx) = channels_write.get(&query_id) {
            if tx.receiver_count() == 0 {
                channels_write.remove(&query_id);
                info!("removed empty broadcast channel for query_id={}", query_id);
            }
        }
    }
}

/// Helper module for hyper WebSocket upgrade (bridges hyper 1.x with tungstenite)
mod hyper_tungstenite_upgrade {
    use hyper::body::Incoming;
    use hyper::header::{CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY, UPGRADE};
    use hyper::{Request, Response, StatusCode};
    use hyper_util::rt::TokioIo;
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    use tokio_tungstenite::WebSocketStream;

    pub fn is_upgrade_request(req: &Request<Incoming>) -> bool {
        req.headers()
            .get(UPGRADE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }

    pub fn upgrade(
        req: Request<Incoming>,
    ) -> Result<
        (
            Response<()>,
            impl std::future::Future<
                Output = Result<
                    WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>,
                    tokio_tungstenite::tungstenite::Error,
                >,
            >,
        ),
        &'static str,
    > {
        let key = req
            .headers()
            .get(SEC_WEBSOCKET_KEY)
            .ok_or("missing Sec-WebSocket-Key")?
            .to_str()
            .map_err(|_| "invalid Sec-WebSocket-Key")?
            .to_string();

        let accept = derive_accept_key(key.as_bytes());

        let response = Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(UPGRADE, "websocket")
            .header(CONNECTION, "Upgrade")
            .header(SEC_WEBSOCKET_ACCEPT, accept)
            .body(())
            .unwrap();

        let upgrade_future = async move {
            let upgraded = hyper::upgrade::on(req)
                .await
                .map_err(|_| tokio_tungstenite::tungstenite::Error::Protocol(
                    tokio_tungstenite::tungstenite::error::ProtocolError::HandshakeIncomplete,
                ))?;
            let io = TokioIo::new(upgraded);
            let ws = WebSocketStream::from_raw_socket(
                io,
                tokio_tungstenite::tungstenite::protocol::Role::Server,
                None,
            )
            .await;
            Ok(ws)
        };

        Ok((response, upgrade_future))
    }
}
