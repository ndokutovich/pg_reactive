use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::state::Channels;

/// Fetch the current snapshot for a query_id from PG.
async fn fetch_snapshot(pool: &PgPool, query_id: &str) -> Vec<serde_json::Value> {
    // Sanitize query_id: only alphanumeric, underscore, or hyphen
    if !query_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return vec![];
    }

    // Use proper identifier quoting to prevent SQL injection
    let safe_id = query_id.replace('"', "\"\"");
    let sql = format!(
        "SELECT row_to_json(t) AS doc FROM pgr.\"_snap_{}\" t",
        safe_id
    );
    match sqlx::query_scalar::<sqlx::Postgres, serde_json::Value>(&sql)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!("snapshot fetch failed for {}: {}", query_id, e);
            vec![]
        }
    }
}

/// Handle an established WebSocket connection for a given query_id.
pub async fn handle_websocket(
    socket: WebSocket,
    query_id: String,
    channels: Channels,
    pg_pool: PgPool,
    broadcast_capacity: usize,
) {
    info!("WebSocket connected: query_id={}", query_id);

    // Subscribe to the broadcast channel for this query_id
    let mut rx = {
        let mut channels_write = channels.write().await;
        let tx = channels_write
            .entry(query_id.clone())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(broadcast_capacity);
                tx
            });
        tx.subscribe()
    };

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Send a welcome message
    let welcome = serde_json::json!({
        "type": "subscribed",
        "query_id": query_id,
    });
    if let Err(e) = ws_tx.send(Message::Text(welcome.to_string().into())).await {
        error!("failed to send welcome: {}", e);
        return;
    }

    // Send initial snapshot
    let snapshot_rows = fetch_snapshot(&pg_pool, &query_id).await;
    if !snapshot_rows.is_empty() {
        let snapshot_msg = serde_json::json!({
            "query_id": query_id,
            "inserted": snapshot_rows,
            "deleted": [],
        });
        if let Err(e) = ws_tx
            .send(Message::Text(snapshot_msg.to_string().into()))
            .await
        {
            error!("failed to send snapshot: {}", e);
            return;
        }
        info!(
            "sent initial snapshot ({} rows) for query_id={}",
            snapshot_rows.len(),
            query_id
        );
    }

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(payload) => {
                        if let Err(e) = ws_tx.send(Message::Text(payload.into())).await {
                            info!("WebSocket send error: {}", e);
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("client lagged by {} messages, sending overflow", n);
                        let overflow = serde_json::json!({
                            "type": "overflow",
                            "query_id": query_id,
                            "fetch": true,
                        });
                        let _ = ws_tx.send(Message::Text(overflow.to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        info!("broadcast channel closed");
                        break;
                    }
                }
            }

            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        info!("WebSocket disconnected (query_id={})", query_id);
                        break;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_tx.send(Message::Pong(data)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        info!("WebSocket error: {}", e);
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
