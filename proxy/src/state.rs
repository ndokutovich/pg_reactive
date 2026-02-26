use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::{broadcast, RwLock, Semaphore};

use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::rest::catalog::Catalog;

/// Per-query broadcast sender. One query_id -> N WebSocket clients.
pub type Channels = Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>;

/// Shared application state, injected into all handlers via axum State.
#[derive(Clone)]
pub struct AppState {
    pub channels: Channels,
    pub config: Config,
    pub pg_connected: Arc<AtomicBool>,
    pub pg_pool: PgPool,
    pub catalog: Catalog,
    pub auth_rate_limiter: RateLimiter,
    /// Semaphore to limit concurrent WebSocket connections.
    pub ws_semaphore: Arc<Semaphore>,
    /// SMTP mailer (logs to console when SMTP not configured).
    pub mailer: Arc<crate::auth::mailer::Mailer>,
}

impl AppState {
    pub fn new(config: Config, pg_pool: PgPool) -> Self {
        let rate_limiter = RateLimiter::new(
            config.auth_rate_limit,
            config.auth_rate_window_secs,
        );
        let ws_semaphore = Arc::new(Semaphore::new(config.max_connections));
        let mailer = Arc::new(crate::auth::mailer::Mailer::from_env());
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            config,
            pg_connected: Arc::new(AtomicBool::new(false)),
            pg_pool,
            catalog: Catalog::new(),
            auth_rate_limiter: rate_limiter,
            ws_semaphore,
            mailer,
        }
    }
}
