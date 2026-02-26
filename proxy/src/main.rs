mod auth;
mod config;
mod error;
mod middleware;
mod realtime;
mod rest;
mod routes;
mod state;

use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::Router;
use sqlx::PgPool;
use tokio::net::TcpListener;
use tracing::{info, warn};

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pgstack_proxy=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();

    if config.jwt_secret.is_some() {
        info!("JWT authentication enabled");
    } else {
        warn!("JWT_SECRET not set — authentication disabled");
    }

    if config.enable_sql_endpoint {
        warn!("ENABLE_SQL_ENDPOINT=true — /api/sql accepts unauthenticated requests (disable in production!)");
    }

    if config.allowed_origins.is_none() {
        warn!("ALLOWED_ORIGINS not set — CORS is permissive (set to restrict in production)");
    }

    let pg_pool = PgPool::connect(&config.database_url)
        .await
        .expect("failed to connect to PostgreSQL");
    info!("PG connection pool ready");

    let state = AppState::new(config.clone(), pg_pool);

    // Load catalog (table metadata for REST API)
    if let Err(e) = state.catalog.refresh(&state.pg_pool).await {
        warn!("catalog refresh failed (REST API may not work): {}", e);
    }

    // Spawn the PG LISTEN task
    let pg_channels = state.channels.clone();
    let pg_connected = state.pg_connected.clone();
    let pg_url = config.database_url.clone();
    tokio::spawn(async move {
        realtime::listener::pg_listener_loop(&pg_url, pg_channels, pg_connected).await;
    });

    // Build router
    let app = build_router(state);

    // Start server
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .expect("failed to bind");
    info!(
        "pgstack-proxy listening on {} (max_connections={})",
        config.listen_addr, config.max_connections
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");

    info!("shutdown complete");
}

/// Maximum request body size: 1 MB.
const MAX_BODY_SIZE: usize = 1024 * 1024;

fn build_router(state: AppState) -> Router {
    // Auth routes with rate limiting (signup + token are brute-force targets)
    let auth_rate_limited = Router::new()
        .route("/auth/v1/signup", post(auth::routes::signup))
        .route("/auth/v1/token", post(auth::routes::token))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::rate_limit_auth,
        ));

    Router::new()
        // Health check
        .route("/health", get(routes::health::health))
        // WebSocket (pg_reactive)
        .route("/ws/{query_id}", get(ws_handler))
        // Auth (rate-limited signup + token)
        .merge(auth_rate_limited)
        // Auth (non-rate-limited)
        .route("/auth/v1/user", get(auth::routes::get_user).patch(auth::routes::update_user))
        .route("/auth/v1/logout", post(auth::routes::logout))
        // OAuth
        .route("/auth/v1/authorize", get(auth::oauth::authorize))
        .route("/auth/v1/callback", get(auth::oauth::callback))
        // REST API (PostgREST-compatible CRUD)
        .route(
            "/rest/v1/{table}",
            get(rest::handlers::select_rows)
                .post(rest::handlers::insert_rows)
                .patch(rest::handlers::update_rows)
                .delete(rest::handlers::delete_rows),
        )
        // RPC (PostgreSQL function calls)
        .route(
            "/rest/v1/rpc/{function}",
            get(rest::rpc::call_rpc_get).post(rest::rpc::call_rpc),
        )
        // RLS debug (shows current PG role and JWT claims)
        .route("/rest/v1/rls-debug", get(routes::rls_debug::rls_debug))
        // Legacy/demo routes (backwards compatibility with pg_reactive tutorial)
        .route("/api/demo", post(routes::demo::demo_action))
        .route("/api/sql", post(routes::sql::sql_execute))
        // Request body size limit (1 MB)
        .layer(tower_http::limit::RequestBodyLimitLayer::new(MAX_BODY_SIZE))
        // Security headers
        .layer(axum::middleware::from_fn(
            middleware::security_headers::security_headers,
        ))
        // CORS
        .layer(middleware::cors::cors_layer(
            state.config.allowed_origins.as_deref(),
        ))
        .with_state(state)
}

/// WebSocket handler wrapper — axum needs `Request` parts for extractors.
async fn ws_handler(
    state: axum::extract::State<AppState>,
    path: axum::extract::Path<String>,
    ws: axum::extract::WebSocketUpgrade,
    req: axum::extract::OriginalUri,
    headers: axum::http::HeaderMap,
) -> Result<impl axum::response::IntoResponse, error::AppError> {
    let query_id = path.0;

    if query_id.is_empty() {
        return Err(error::AppError::BadRequest("missing query_id".into()));
    }

    // JWT authentication (if secret is configured)
    if let Some(ref secret) = state.config.jwt_secret {
        let auth_header = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        let query_str = req.0.query();
        let token = auth::jwt::extract_token_from_header(auth_header, None, query_str);

        match token {
            Some(t) => {
                if let Err(e) = auth::jwt::validate_token(&t, secret) {
                    return Err(error::AppError::Unauthorized(e));
                }
            }
            None => {
                // Check if it's the anon key
                let is_anon_key = state.config.anon_key.as_ref().map_or(false, |ak| {
                    auth_header
                        .and_then(|h| h.strip_prefix("Bearer "))
                        .map_or(false, |t| t == ak)
                });
                if !is_anon_key {
                    return Err(error::AppError::Unauthorized(
                        "authentication required".into(),
                    ));
                }
            }
        }
    }

    // Acquire a WebSocket connection permit (FIX W1: connection limiting)
    let permit = state
        .ws_semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            error::AppError::TooManyRequests("too many WebSocket connections".into())
        })?;

    let channels = state.channels.clone();
    let pg_pool = state.pg_pool.clone();

    Ok(ws.on_upgrade(move |socket| {
        // The permit is moved into the async block and held for the connection lifetime.
        // It is released automatically when the future completes and permit is dropped.
        async move {
            realtime::ws::handle_websocket(socket, query_id, channels, pg_pool).await;
            drop(permit);
        }
    }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
