mod auth;
mod config;
mod error;
mod middleware;
mod realtime;
mod rest;
mod routes;
mod state;

use std::net::SocketAddr;

use axum::routing::{delete, get, post};
use axum::Router;
use sqlx::postgres::PgPoolOptions;
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

    let pg_pool = PgPoolOptions::new()
        .max_connections(50)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to PostgreSQL");
    info!("PG connection pool ready (max_connections=50)");

    let state = AppState::new(config.clone(), pg_pool);

    // Load catalog (table metadata for REST API)
    if let Err(e) = state.catalog.refresh(&state.pg_pool).await {
        warn!("catalog refresh failed (REST API may not work): {}", e);
    }

    // Spawn the PG LISTEN task
    let pg_channels = state.channels.clone();
    let pg_connected = state.pg_connected.clone();
    let pg_url = config.database_url.clone();
    let pg_max_backoff = config.pg_reconnect_max_backoff_secs;
    tokio::spawn(async move {
        realtime::listener::pg_listener_loop(&pg_url, pg_channels, pg_connected, pg_max_backoff).await;
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

fn build_router(state: AppState) -> Router {
    // Auth routes with rate limiting (signup + token are brute-force targets)
    let auth_rate_limited = Router::new()
        .route("/auth/v1/signup", post(auth::routes::signup))
        .route("/auth/v1/token", post(auth::routes::token))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::rate_limit_auth,
        ));

    // All API routes with strict CSP
    let api_router = Router::new()
        // Health check
        .route("/health", get(routes::health::health))
        // WebSocket (pg_reactive)
        .route("/ws/{query_id}", get(ws_handler))
        // Auth (rate-limited signup + token)
        .merge(auth_rate_limited)
        // Auth (non-rate-limited)
        .route("/auth/v1/user", get(auth::routes::get_user).patch(auth::routes::update_user))
        .route("/auth/v1/logout", post(auth::routes::logout))
        // Email auth flows
        .route("/auth/v1/recover", post(auth::routes::recover))
        .route("/auth/v1/recover/confirm", post(auth::routes::recover_confirm))
        .route("/auth/v1/verify", get(auth::routes::verify_email))
        .route("/auth/v1/magiclink", post(auth::routes::magiclink))
        .route("/auth/v1/magiclink/verify", get(auth::routes::magiclink_verify))
        // Admin
        .route(
            "/auth/v1/admin/users",
            get(auth::routes::admin_list_users).post(auth::routes::admin_create_user),
        )
        .route("/auth/v1/admin/users/{id}", delete(auth::routes::admin_delete_user))
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
        // Catalog refresh (force-reload table metadata)
        .route("/api/catalog/refresh", post(routes::catalog_refresh::catalog_refresh))
        // Request body size limit
        .layer(tower_http::limit::RequestBodyLimitLayer::new(state.config.max_body_size))
        // Strict security headers for API
        .layer(axum::middleware::from_fn(
            middleware::security_headers::security_headers,
        ))
        .with_state(state.clone());

    // Studio SPA routes with relaxed CSP
    let studio_router = Router::new()
        .route("/studio", get(routes::studio::studio_redirect))
        .nest_service("/studio/", routes::studio::studio_service())
        .layer(axum::middleware::from_fn(
            middleware::security_headers::studio_security_headers,
        ));

    // Merge: studio checked first, then API.
    // CORS goes on the outer router so it applies to both.
    Router::new()
        .merge(studio_router)
        .merge(api_router)
        .layer(middleware::cors::cors_layer(
            state.config.allowed_origins.as_deref(),
        ))
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

        // Check anon key first via Bearer header (it's not a JWT, so don't try to validate it as one)
        let is_anon_key = state.config.anon_key.as_ref().map_or(false, |ak| {
            auth_header
                .and_then(|h| h.strip_prefix("Bearer "))
                .map_or(false, |t| auth::keys::constant_time_eq(t, ak))
        });

        // Also check ?apikey= query param (browsers can't set custom headers on WebSocket)
        let is_apikey_auth = if !is_anon_key {
            if let Some(q) = query_str {
                let apikey_value = q.split('&')
                    .find_map(|pair| pair.strip_prefix("apikey="));
                if let Some(key) = apikey_value {
                    // Check against anon_key
                    let is_anon = state.config.anon_key.as_ref()
                        .map_or(false, |ak| auth::keys::constant_time_eq(key, ak));
                    // Check against service_role_key
                    let is_service = state.config.service_role_key.as_ref()
                        .map_or(false, |srk| auth::keys::constant_time_eq(key, srk));
                    is_anon || is_service
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };

        if !is_anon_key && !is_apikey_auth {
            let token = auth::jwt::extract_token_from_header(auth_header, None, query_str);
            match token {
                Some(t) => {
                    if let Err(e) = auth::jwt::validate_token(&t, secret) {
                        return Err(error::AppError::Unauthorized(e));
                    }
                }
                None => {
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
    let broadcast_capacity = state.config.broadcast_capacity;

    Ok(ws.on_upgrade(move |socket| {
        // The permit is moved into the async block and held for the connection lifetime.
        // It is released automatically when the future completes and permit is dropped.
        async move {
            realtime::ws::handle_websocket(socket, query_id, channels, pg_pool, broadcast_capacity).await;
            drop(permit);
        }
    }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
