use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::{broadcast, RwLock};

use crate::config::Config;
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
}

impl AppState {
    pub fn new(config: Config, pg_pool: PgPool) -> Self {
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            config,
            pg_connected: Arc::new(AtomicBool::new(false)),
            pg_pool,
            catalog: Catalog::new(),
        }
    }
}
