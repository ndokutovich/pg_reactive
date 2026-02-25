use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tracing::{error, info, warn};

use crate::state::Channels;

/// Connects to PG and listens on `pgr` channel, dispatching to broadcast channels.
/// Uses exponential backoff on connection failures (1s -> 2s -> 4s -> ... -> 30s max).
pub async fn pg_listener_loop(pg_url: &str, channels: Channels, pg_connected: Arc<AtomicBool>) {
    let mut backoff_secs: u64 = 1;
    loop {
        pg_connected.store(false, Ordering::Relaxed);
        match pg_listener_run(pg_url, &channels, &pg_connected).await {
            Ok(()) => {
                info!("PG listener exited normally, reconnecting...");
                backoff_secs = 1;
            }
            Err(e) => {
                error!(
                    "PG listener error: {}, reconnecting in {}s...",
                    e, backoff_secs
                );
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
    listener.listen("pgr").await?;
    pg_connected.store(true, Ordering::Relaxed);
    info!("connected to PG, listening on channel 'pgr'");

    loop {
        let notification = listener.recv().await?;
        let payload = notification.payload();

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

        let channels_read = channels.read().await;
        if let Some(tx) = channels_read.get(&query_id) {
            let _ = tx.send(payload.to_string());
        }
    }
}
