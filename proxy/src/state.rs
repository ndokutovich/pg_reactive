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
    /// Data pool: connects as the powerless `authenticator` login role; each
    /// request does SET LOCAL ROLE anon|authenticated so RLS is enforced.
    pub pg_pool: PgPool,
    /// Admin pool: its connections assume `service_role` (BYPASSRLS) for trusted
    /// backend ops — auth, catalog, /api/sql, demo. A SEPARATE login role
    /// (authenticator_admin) so a data-plane compromise can't reach service_role.
    pub admin_pool: PgPool,
    pub catalog: Catalog,
    pub auth_rate_limiter: RateLimiter,
    /// Semaphore to limit concurrent WebSocket connections.
    pub ws_semaphore: Arc<Semaphore>,
    /// SMTP mailer (logs to console when SMTP not configured).
    pub mailer: Arc<crate::auth::mailer::Mailer>,
}

impl AppState {
    pub fn new(config: Config, pg_pool: PgPool, admin_pool: PgPool) -> Self {
        let rate_limiter = RateLimiter::new(config.auth_rate_limit, config.auth_rate_window_secs);
        let ws_semaphore = Arc::new(Semaphore::new(config.max_connections));
        let mailer = Arc::new(crate::auth::mailer::Mailer::from_env());
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            config,
            pg_connected: Arc::new(AtomicBool::new(false)),
            pg_pool,
            admin_pool,
            catalog: Catalog::new(),
            auth_rate_limiter: rate_limiter,
            ws_semaphore,
            mailer,
        }
    }

    /// Pick the pool for a data-plane request by its resolved role. service_role
    /// requests run on the admin pool (the data login role cannot assume
    /// service_role); anon/authenticated run on the data pool with SET LOCAL ROLE.
    pub fn pool_for(&self, role: &str) -> &PgPool {
        if role == "service_role" {
            &self.admin_pool
        } else {
            &self.pg_pool
        }
    }
}
