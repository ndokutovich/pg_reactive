mod auth;
mod config;
mod db_roles;
mod error;
mod functions;
mod middleware;
mod realtime;
mod rest;
mod routes;
mod secrets;
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

    // Production posture validator (fail-secure). validate() only returns problems
    // when PGSTACK_ENV=production, and there they are fatal.
    {
        let problems = config.validate();
        if !problems.is_empty() {
            for p in &problems {
                tracing::error!("config: {p}");
            }
            panic!(
                "configuration invalid for PGSTACK_ENV=production: {} problem(s) — refusing to start",
                problems.len()
            );
        }
    }

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
        .expect("failed to connect to PostgreSQL (data pool)");

    // Admin pool: every connection assumes `service_role` for trusted backend ops
    // (auth, catalog, /api/sql, demo). Uses a SEPARATE login role
    // (authenticator_admin) so a data-plane compromise can't reach service_role.
    let admin_pool = PgPoolOptions::new()
        .max_connections(20)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE service_role").execute(&mut *conn).await?;
                Ok(())
            })
        })
        .connect(&config.admin_database_url)
        .await
        .expect("failed to connect to PostgreSQL (admin pool) — set ADMIN_DATABASE_URL to the authenticator_admin login role");
    info!("PG pools ready (data max=50, admin max=20)");

    // Startup role verification — refuse to boot with an unsafe DB role in production.
    db_roles::verify_pool_roles(&pg_pool, &admin_pool, &config).await;

    let state = AppState::new(config.clone(), pg_pool, admin_pool);

    // One-shot orphan sweep for the disk storage backend (audit F1 round 19/20):
    // clears partial-upload staging/backup files left by uploads killed mid-flight.
    // Runs only when STORAGE_BACKEND=disk. Mirror of Go main.go's startup sweep.
    if config.storage_backend == "disk" && !config.storage_dir.is_empty() {
        let dir = config.storage_dir.clone();
        tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                routes::storage::sweep_disk_orphans(&dir, std::time::Duration::from_secs(600));
            })
            .await
            .ok();
        });
    }

    // Load catalog (table metadata for REST API)
    if let Err(e) = state.catalog.refresh(&state.admin_pool).await {
        warn!("catalog refresh failed (REST API may not work): {}", e);
    }

    // Load webhooks from the DB before the listener starts dispatching events.
    if let Err(e) = state.webhook_manager.refresh().await {
        warn!("initial webhook load failed — webhooks will retry on next refresh: {e}");
    }

    // Load the edge-functions catalog (admin pool — the table is service_role
    // only), then auto-refresh on `pgstack_fn_changed` NOTIFY. Mirror Go's
    // initial Refresh + StartAutoRefresh.
    if let Err(e) = state.functions.refresh(&state.admin_pool).await {
        warn!("initial edge functions catalog load failed — functions may 404 until refreshed: {e}");
    } else {
        info!("edge functions catalog loaded");
    }
    functions::spawn_auto_refresh(
        state.functions.clone(),
        state.admin_pool.clone(),
        config.admin_database_url.clone(),
    );

    // Spawn the PG LISTEN task
    let pg_channels = state.channels.clone();
    let pg_connected = state.pg_connected.clone();
    let pg_url = config.database_url.clone();
    let pg_max_backoff = config.pg_reconnect_max_backoff_secs;
    let pg_notify_channel = config.notify_channel.clone();
    let pg_webhook_manager = state.webhook_manager.clone();
    tokio::spawn(async move {
        realtime::listener::pg_listener_loop(
            &pg_url,
            pg_channels,
            pg_connected,
            pg_max_backoff,
            &pg_notify_channel,
            pg_webhook_manager,
        )
        .await;
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
    // Auth routes with rate limiting. signup + token are brute-force targets;
    // recover / recover/confirm / magiclink are email-bombing targets. Mirrors
    // the Go `state.RateLimiter` group (main.go). verify + magiclink/verify are
    // GET confirmation links and stay un-rate-limited (as in Go).
    let auth_rate_limited = Router::new()
        .route("/auth/v1/signup", post(auth::routes::signup))
        .route("/auth/v1/token", post(auth::routes::token))
        .route("/auth/v1/recover", post(auth::routes::recover))
        .route(
            "/auth/v1/recover/confirm",
            post(auth::routes::recover_confirm),
        )
        .route("/auth/v1/magiclink", post(auth::routes::magiclink))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::rate_limit_auth,
        ));

    // Anonymous signin in its own, more generous bucket (stateless mint — no DB
    // write, no email). Mirrors Go's `state.AnonymousLimiter` group.
    let anonymous_rate_limited = Router::new()
        .route("/auth/v1/anonymous", post(auth::routes::anonymous))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::rate_limit::rate_limit_anonymous,
        ));

    // /api/demo mutates demo tables — mount only when explicitly enabled or a
    // service_role key is configured (the handler still gates every request).
    // Mirrors Go main.go's `EnableDemoEndpoint || ServiceRoleKey != ""` gate.
    let mount_demo =
        state.config.enable_demo_endpoint || state.config.service_role_key.is_some();

    // All API routes with strict CSP
    let mut api_router = Router::new()
        // Health check
        .route("/health", get(routes::health::health))
        // WebSocket (pg_reactive)
        .route("/ws/{query_id}", get(ws_handler))
        // Presence HTTP read — same auth + audience gate as the WS upgrade so it
        // isn't a side channel into private rooms; filtered to the channel's
        // current committed generation (inv 17(a)(f)).
        .route("/ws/_presence/{channel}", get(presence_handler))
        // Auth (rate-limited: signup, token, recover, recover/confirm, magiclink)
        .merge(auth_rate_limited)
        // Auth (anonymous signin — separate rate-limit bucket)
        .merge(anonymous_rate_limited)
        // Auth (non-rate-limited)
        .route(
            "/auth/v1/user",
            get(auth::routes::get_user).patch(auth::routes::update_user),
        )
        .route("/auth/v1/logout", post(auth::routes::logout))
        // Email confirmation links (GET — not rate-limited, mirror Go)
        .route("/auth/v1/verify", get(auth::routes::verify_email))
        .route(
            "/auth/v1/magiclink/verify",
            get(auth::routes::magiclink_verify),
        )
        // Admin
        .route(
            "/auth/v1/admin/users",
            get(auth::routes::admin_list_users).post(auth::routes::admin_create_user),
        )
        .route(
            "/auth/v1/admin/users/{id}",
            delete(auth::routes::admin_delete_user),
        )
        // OAuth
        .route("/auth/v1/authorize", get(auth::oauth::authorize))
        .route("/auth/v1/callback", get(auth::oauth::callback))
        // Transaction batching — mounted BEFORE the {table} wildcard so "batch"
        // is not treated as a table name (mirrors Go's route order).
        .route("/rest/v1/batch", post(rest::batch::batch))
        // Webhook CRUD (service_role only) — mounted BEFORE the {table} wildcard
        // so "webhooks" is not treated as a table name (mirrors Go's route
        // order). matchit prioritizes these static segments over {table}.
        .route(
            "/rest/v1/webhooks",
            post(routes::webhooks::create_webhook).get(routes::webhooks::list_webhooks),
        )
        .route(
            "/rest/v1/webhooks/{id}",
            delete(routes::webhooks::delete_webhook),
        )
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
        // Legacy SQL route (backwards compatibility with pg_reactive tutorial)
        .route("/api/sql", post(routes::sql::sql_execute))
        // Catalog refresh (force-reload table metadata)
        .route(
            "/api/catalog/refresh",
            post(routes::catalog_refresh::catalog_refresh),
        )
        // Edge Functions (/functions/v1/). The literal `_health` / `_refresh` /
        // trailing-slash routes are distinct paths from the `{name}` wildcard;
        // matchit prioritises the static segments, so `_health` is never shadowed
        // by a function named "_health" (gemini audit P3 — mirror Go's explicit
        // ordering).
        .route("/functions/v1/", get(functions::list))
        .route("/functions/v1/_refresh", post(functions::refresh))
        .route("/functions/v1/_health", get(functions::deno_health))
        .route(
            "/functions/v1/{name}",
            get(functions::invoke).post(functions::invoke),
        );

    if mount_demo {
        api_router = api_router.route("/api/demo", post(routes::demo::demo_action));
    }

    let api_router = api_router
        // Request body size limit
        .layer(tower_http::limit::RequestBodyLimitLayer::new(
            state.config.max_body_size,
        ))
        // Strict security headers for API
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
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

    // Storage routes — own group with NO 1 MB RequestBodyLimit (uploads are
    // large); instead a per-route DefaultBodyLimit of MAX_FILE_SIZE + 1 KB caps
    // the stream, mirroring Go's MaxBytesReader (over-limit → 413). Route order
    // mirrors Go's chi mounts: the static `object/list/{bucket}` is registered
    // before the `object/{bucket}/{*path}` catch-all.
    let storage_body_limit = (state.config.max_file_size.max(0) as usize).saturating_add(1024);
    let storage_router = Router::new()
        .route(
            "/storage/v1/bucket",
            post(routes::storage::create_bucket).get(routes::storage::list_buckets),
        )
        .route(
            "/storage/v1/bucket/{bucketId}",
            delete(routes::storage::delete_bucket),
        )
        .route(
            "/storage/v1/object/list/{bucket}",
            get(routes::storage::list_objects),
        )
        .route(
            "/storage/v1/object/{bucket}/{*path}",
            post(routes::storage::upload_object)
                .get(routes::storage::download_object)
                .delete(routes::storage::delete_object),
        )
        .layer(axum::extract::DefaultBodyLimit::max(storage_body_limit))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::security_headers::security_headers,
        ))
        .with_state(state.clone());

    // Merge: studio checked first, then storage, then API.
    // CORS goes on the outer router so it applies to all.
    Router::new()
        .merge(studio_router)
        .merge(storage_router)
        .merge(api_router)
        .layer(middleware::cors::cors_layer(
            state.config.allowed_origins.as_deref(),
            state.config.allow_permissive_cors,
        ))
}

/// WebSocket handler wrapper — axum needs `Request` parts for extractors.
async fn ws_handler(
    state: axum::extract::State<AppState>,
    path: axum::extract::Path<String>,
    ws: axum::extract::WebSocketUpgrade,
    req: axum::extract::OriginalUri,
    conn: axum::extract::ConnectInfo<SocketAddr>,
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
        let is_anon_key = state.config.anon_key.as_ref().is_some_and(|ak| {
            auth_header
                .and_then(|h| h.strip_prefix("Bearer "))
                .is_some_and(|t| auth::keys::constant_time_eq(t, ak))
        });

        // Also check ?apikey= query param (browsers can't set custom headers on WebSocket)
        let is_apikey_auth = if !is_anon_key {
            if let Some(q) = query_str {
                let apikey_value = q.split('&').find_map(|pair| pair.strip_prefix("apikey="));
                if let Some(key) = apikey_value {
                    // Check against anon_key
                    let is_anon = state
                        .config
                        .anon_key
                        .as_ref()
                        .is_some_and(|ak| auth::keys::constant_time_eq(key, ak));
                    // Check against service_role_key
                    let is_service = state
                        .config
                        .service_role_key
                        .as_ref()
                        .is_some_and(|srk| auth::keys::constant_time_eq(key, srk));
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

        // REQUIRE_AUTHENTICATED_WS: an anon-key subscription is rejected when set —
        // only an authenticated JWT or service_role may open a live-query WS.
        if state.config.require_authenticated_ws {
            let anon_via_apikey = query_str
                .and_then(|q| q.split('&').find_map(|p| p.strip_prefix("apikey=")))
                .is_some_and(|key| {
                    state
                        .config
                        .anon_key
                        .as_ref()
                        .is_some_and(|ak| auth::keys::constant_time_eq(key, ak))
                });
            if is_anon_key || anon_via_apikey {
                return Err(error::AppError::Unauthorized(
                    "authenticated WebSocket required (anon key rejected)".into(),
                ));
            }
        }

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

    // WS Origin validation: browsers don't enforce same-origin on ws://, so check
    // it here when ALLOWED_ORIGINS is set. Non-browser clients (no Origin) pass.
    if let Some(allowed) = state.config.allowed_origins.as_deref() {
        if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
            if !allowed.split(',').any(|a| a.trim() == origin) {
                return Err(error::AppError::Forbidden("origin not allowed".into()));
            }
        }
    }

    // Resolve the connection identity (role + sub + claims) for the audience gate.
    // The block above already enforced auth / REQUIRE_AUTHENTICATED_WS.
    let claims = resolve_ws_claims(&state, &headers, req.0.query());

    // Per-IP WebSocket connection cap (parity with Go middleware.WSConnLimiter,
    // round 22): one client must not be able to exhaust the global pool. XFF is
    // honoured only from TRUSTED_PROXIES (SECURITY.md invariant 4) — reuse the
    // rate-limiter's resolver so the IP source matches the auth limiter exactly.
    let trusted: Vec<std::net::IpAddr> = state
        .config
        .trusted_proxies
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let client_ip =
        middleware::rate_limit::resolve_client_ip(&headers, conn.0.ip(), &trusted);
    let ip_guard = state
        .ws_conn_limiter
        .try_acquire(client_ip)
        .ok_or_else(|| {
            error::AppError::TooManyRequests(
                "too many concurrent websocket connections from this address".into(),
            )
        })?;

    // Acquire a global WebSocket connection permit (FIX W1: connection limiting).
    // Both caps apply, like Go (global semaphore + per-IP limiter).
    let permit = state
        .ws_semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| error::AppError::TooManyRequests("too many WebSocket connections".into()))?;

    let channels = state.channels.clone();
    let presence = state.presence.clone();
    // subscription_meta gate + initial snapshot read pgr.* (only service_role can) —
    // use the admin pool. The generation/audience gating happens in handle_websocket.
    let pg_pool = state.admin_pool.clone();
    let broadcast_capacity = state.config.broadcast_capacity;

    // Hard-cap inbound frames (parity with Go conn.SetReadLimit(maxWSMessageBytes)).
    let ws = ws.max_message_size(realtime::ws::MAX_WS_MESSAGE_BYTES);

    Ok(ws.on_upgrade(move |socket| {
        // Both the global permit and the per-IP guard are moved into the async
        // block and held for the connection lifetime. They are released
        // automatically when the future completes and they are dropped.
        async move {
            realtime::ws::handle_websocket(
                socket,
                query_id,
                channels,
                presence,
                pg_pool,
                broadcast_capacity,
                claims,
            )
            .await;
            drop(permit);
            drop(ip_guard);
        }
    }))
}

/// Re-resolve the WebSocket connection's identity (role + sub + claims JSON) for
/// the audience gate. Auth (401 / REQUIRE_AUTHENTICATED_WS) is already enforced
/// by ws_handler, so this never rejects — service_role key → service_role, a
/// valid JWT (Bearer or ?token=) → its claims, otherwise anon.
fn resolve_ws_claims(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    query_str: Option<&str>,
) -> middleware::rls::RequestClaims {
    use middleware::rls::RequestClaims;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let apikey_q = query_str.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("apikey=")));
    let token_q = query_str.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("token=")));
    let matches = |val: Option<&str>, key: &Option<String>| matches!((val, key), (Some(v), Some(k)) if auth::keys::constant_time_eq(v, k));
    if matches(bearer, &state.config.service_role_key)
        || matches(apikey_q, &state.config.service_role_key)
    {
        return RequestClaims::service_role();
    }
    if let Some(secret) = &state.config.jwt_secret {
        if let Some(t) = bearer.or(token_q) {
            if let Ok(c) = auth::jwt::validate_token(t, secret) {
                return RequestClaims::from_jwt(&c);
            }
        }
    }
    RequestClaims::anon()
}

/// GET /ws/_presence/{channel} — current presence list for a channel.
///
/// Runs the SAME auth + audience gate as `ws_handler` so it is not an
/// unauthenticated side channel into a private room, and returns ONLY the
/// presence written under the channel's current committed generation
/// (SECURITY.md inv 17(a)(f)). Mirror of Go `realtime.PresenceHandler`.
async fn presence_handler(
    state: axum::extract::State<AppState>,
    path: axum::extract::Path<String>,
    req: axum::extract::OriginalUri,
    headers: axum::http::HeaderMap,
) -> Result<impl axum::response::IntoResponse, error::AppError> {
    let channel = path.0;
    if channel.is_empty() {
        return Err(error::AppError::BadRequest("channel is required".into()));
    }
    let query_str = req.0.query();

    // Auth — same shape as ws_handler: resolve identity and whether the caller is
    // an anon-key holder, enforcing REQUIRE_AUTHENTICATED_WS and JWT presence.
    let mut is_anon = false;
    let claims = if state.config.jwt_secret.is_some() {
        let auth_header = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        let bearer = auth_header.and_then(|h| h.strip_prefix("Bearer "));
        let apikey_q = query_str.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("apikey=")));
        let token_q = query_str.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("token=")));

        let anon_via_bearer = state
            .config
            .anon_key
            .as_ref()
            .is_some_and(|ak| bearer.is_some_and(|t| auth::keys::constant_time_eq(t, ak)));
        let anon_via_apikey = state
            .config
            .anon_key
            .as_ref()
            .is_some_and(|ak| apikey_q.is_some_and(|k| auth::keys::constant_time_eq(k, ak)));
        is_anon = anon_via_bearer || anon_via_apikey;

        if is_anon && state.config.require_authenticated_ws {
            return Err(error::AppError::Unauthorized(
                "authenticated presence read required".into(),
            ));
        }
        if is_anon {
            middleware::rls::RequestClaims::anon()
        } else {
            // A non-anon caller MUST present a credential: a service_role key
            // (bearer/apikey) or a JWT (bearer/?token=). Absent or invalid → 401.
            if bearer.is_none() && apikey_q.is_none() && token_q.is_none() {
                return Err(error::AppError::Unauthorized("authentication required".into()));
            }
            let resolved = resolve_ws_claims(&state, &headers, query_str);
            if resolved.role == "anon" {
                return Err(error::AppError::Unauthorized("authentication required".into()));
            }
            resolved
        }
    } else {
        // Auth disabled (no JWT secret) — mirror the dev WS path: accept.
        middleware::rls::RequestClaims::anon()
    };

    // Audience gate — admin pool reads pgr.subscription_meta (only service_role
    // can). Unknown channel → 404; DB error → 503 (fail closed).
    let (audience, current_gen) = match realtime::ws::subscription_meta(&state.admin_pool, &channel)
        .await
    {
        Ok(Some((_mode, audience, gen))) => (audience, gen),
        Ok(None) => return Err(error::AppError::NotFound("channel not found".into())),
        Err(e) => {
            warn!("presence metadata lookup failed for {channel}: {e}; failing closed");
            return Err(error::AppError::ServiceUnavailable(
                "channel metadata unavailable".into(),
            ));
        }
    };
    if let Some((status, msg)) = realtime::ws::gate_presence_access(&audience, is_anon, &claims) {
        return Err(match status {
            axum::http::StatusCode::FORBIDDEN => error::AppError::Forbidden(msg.into()),
            _ => error::AppError::Unauthorized(msg.into()),
        });
    }

    // Restrict to the current committed generation (inv 17(f)).
    let presence_map = state.presence.list(&channel, current_gen).await;
    Ok(axum::Json(presence_map))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutdown signal received");
}
