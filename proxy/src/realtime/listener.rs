use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tracing::{error, info, warn};

use crate::realtime::webhooks::WebhookManager;
use crate::state::Channels;

/// Connects to PG and listens on the configured NOTIFY channel (default `pgr`,
/// validated as a bare PG identifier at config load), dispatching to broadcast
/// channels. Uses exponential backoff on connection failures
/// (1s -> 2s -> 4s -> ... -> max_backoff_secs).
pub async fn pg_listener_loop(
    pg_url: &str,
    channels: Channels,
    pg_connected: Arc<AtomicBool>,
    max_backoff_secs: u64,
    notify_channel: &str,
    webhook_manager: Arc<WebhookManager>,
) {
    let mut backoff_secs: u64 = 1;
    loop {
        pg_connected.store(false, Ordering::Relaxed);
        match pg_listener_run(
            pg_url,
            &channels,
            &pg_connected,
            notify_channel,
            &webhook_manager,
        )
        .await
        {
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
        backoff_secs = (backoff_secs * 2).min(max_backoff_secs);
    }
}

async fn pg_listener_run(
    pg_url: &str,
    channels: &Channels,
    pg_connected: &AtomicBool,
    notify_channel: &str,
    webhook_manager: &Arc<WebhookManager>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut listener = sqlx::postgres::PgListener::connect(pg_url).await?;
    // sqlx double-quotes the identifier in the LISTEN statement; the channel is
    // also regex-validated at config load, so this is injection-free and must
    // equal the extension's pg_reactive.notify_channel GUC.
    listener.listen(notify_channel).await?;
    // Webhooks ride a dedicated channel fed by the pgstack.webhook_notify()
    // trigger — separate from the live-query delta stream (mirror Go listenOnce).
    listener.listen("pgstack_webhooks").await?;
    pg_connected.store(true, Ordering::Relaxed);
    info!("connected to PG, listening on channel '{notify_channel}' and 'pgstack_webhooks'");

    loop {
        let notification = listener.recv().await?;
        let payload = notification.payload();

        // Webhook trigger events: {table, event, record, old_record}. Dispatch
        // to the manager and move on — these never enter the live-query fan-out.
        if notification.channel() == "pgstack_webhooks" {
            webhook_manager.deliver_from_webhook_notify(payload).await;
            continue;
        }

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

        // The generation the delta/overflow/invalidated/resubscribed was computed
        // under (round 39 batch-2). A connection accepts a message only on EXACT
        // generation match; a `resubscribed` notice with a different generation
        // revokes the stale connection (RevokeStale). resubscribed is
        // proxy-consumed — never forwarded to clients.
        let gen = msg.get("gen").and_then(|v| v.as_i64());
        let resubscribed = msg.get("type").and_then(|v| v.as_str()) == Some("resubscribed");

        let channels_read = channels.read().await;
        if let Some(tx) = channels_read.get(&query_id) {
            let _ = tx.send(crate::state::WsMessage {
                gen,
                resubscribed,
                payload: payload.to_string(),
            });
        }
    }
}
