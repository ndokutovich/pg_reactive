use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::middleware::rls::RequestClaims;
use crate::state::Channels;

/// Proxy-reserved ad-hoc collaboration channels (catalog-less, public delta).
fn is_adhoc(query_id: &str) -> bool {
    query_id.starts_with("_channel_") || query_id.starts_with("_presence_")
}

/// Validate a query_id can form a safe `_snap_<id>` identifier.
fn safe_snap_id(query_id: &str) -> Option<String> {
    if !query_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(query_id.replace('"', "\"\""))
}

/// Read the registered mode / audience / generation from the TRANSACTIONAL
/// catalog `pgr.subscription_meta` (over `pgr.persisted_subscriptions`), NEVER the
/// non-transactional shmem hash `pgr.get_subscriptions()` (SECURITY.md inv 15).
/// Returns None when the subscription does not exist; ad-hoc channels are public
/// delta with generation 0.
async fn subscription_meta(
    pool: &PgPool,
    query_id: &str,
) -> Result<Option<(String, String, i64)>, sqlx::Error> {
    if is_adhoc(query_id) {
        return Ok(Some(("delta".to_string(), String::new(), 0)));
    }
    let row = sqlx::query_as::<_, (String, Option<String>, i64)>(
        "SELECT mode, audience::text, generation FROM pgr.subscription_meta($1)",
    )
    .bind(query_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(mode, aud, gen)| (mode, aud.unwrap_or_default(), gen)))
}

/// True when every key in the audience JSON matches the same key in the JWT
/// claims, by EXACT JSON value (so `{"sub":42}` does NOT match `{"sub":"42"}`).
/// An empty audience is public (allow). A non-NULL but predicate-less audience
/// (`null` / `{}` / non-object) fails closed.
fn claims_satisfy_audience(audience: &str, claims_json: &str) -> bool {
    if audience.is_empty() {
        return true;
    }
    let aud: serde_json::Value = match serde_json::from_str(audience) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let aud_obj = match aud.as_object() {
        Some(o) if !o.is_empty() => o,
        _ => return false,
    };
    let claims: serde_json::Value = match serde_json::from_str(claims_json) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let claims_obj = match claims.as_object() {
        Some(o) => o,
        None => return false,
    };
    for (k, v) in aud_obj {
        match claims_obj.get(k) {
            Some(cv) if cv == v => {}
            _ => return false,
        }
    }
    true
}

/// Fetch the initial snapshot ATOMICALLY with its generation (SECURITY.md inv
/// 17): ONE `REPEATABLE READ` transaction, an `ACCESS SHARE` lock on the `_snap`
/// table (serialises against a re-subscribe's `ACCESS EXCLUSIVE` drop), and a
/// re-check that the generation still equals the one the connection authorized
/// against. Returns `Ok(None)` (→ close) when the generation changed during
/// connect, so we never ship rows from an epoch this connection never authorized.
async fn snapshot_for_generation(
    pool: &PgPool,
    query_id: &str,
    expected_gen: i64,
) -> Result<Option<Vec<serde_json::Value>>, sqlx::Error> {
    let safe = match safe_snap_id(query_id) {
        Some(s) => s,
        None => return Ok(Some(vec![])),
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    if !is_adhoc(query_id) {
        sqlx::query(&format!(
            "LOCK TABLE pgr.\"_snap_{safe}\" IN ACCESS SHARE MODE"
        ))
        .execute(&mut *tx)
        .await?;
        let cur: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM pgr.subscription_meta($1)")
                .bind(query_id)
                .fetch_optional(&mut *tx)
                .await?;
        if cur != Some(expected_gen) {
            let _ = tx.rollback().await;
            return Ok(None);
        }
    }
    let rows = sqlx::query_scalar::<_, serde_json::Value>(&format!(
        "SELECT row_to_json(t) FROM pgr.\"_snap_{safe}\" t"
    ))
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_default();
    tx.commit().await?;
    Ok(Some(rows))
}

async fn close_with(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &str,
) {
    let err = serde_json::json!({ "type": "error", "message": message });
    let _ = ws_tx.send(Message::Text(err.to_string().into())).await;
    let _ = ws_tx.send(Message::Close(None)).await;
}

/// Handle an established WebSocket connection for a given query_id, bound to the
/// generation it authorized against. `claims` is the connection's resolved
/// identity (role + sub + claims JSON) used for the audience gate.
pub async fn handle_websocket(
    socket: WebSocket,
    query_id: String,
    channels: Channels,
    pg_pool: PgPool,
    broadcast_capacity: usize,
    claims: RequestClaims,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // 1. Audience/mode/generation gate from the transactional catalog (inv 15).
    let (_mode, audience, my_gen) = match subscription_meta(&pg_pool, &query_id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            close_with(&mut ws_tx, "subscription not found").await;
            return;
        }
        Err(e) => {
            warn!("subscription metadata lookup failed for {query_id}: {e}; failing closed");
            close_with(&mut ws_tx, "subscription metadata unavailable").await;
            return;
        }
    };

    // 2. Audience gate (inv 16): a non-public subscription is only deliverable to
    //    a JWT whose claims satisfy the audience. service_role bypasses.
    if !audience.is_empty()
        && claims.role != "service_role"
        && (claims.sub.is_none() || !claims_satisfy_audience(&audience, &claims.claims_json))
    {
        close_with(
            &mut ws_tx,
            "JWT claims do not satisfy subscription audience",
        )
        .await;
        return;
    }

    info!("WebSocket connected: query_id={query_id} gen={my_gen}");

    // 3. Subscribe to the broadcast channel for this query_id.
    let mut rx = {
        let mut channels_write = channels.write().await;
        let tx = channels_write.entry(query_id.clone()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(broadcast_capacity);
            tx
        });
        tx.subscribe()
    };

    // 4. Welcome.
    let welcome = serde_json::json!({ "type": "subscribed", "query_id": query_id });
    if ws_tx
        .send(Message::Text(welcome.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    // 5. Initial snapshot, read atomically with my_gen (inv 17).
    match snapshot_for_generation(&pg_pool, &query_id, my_gen).await {
        Ok(Some(rows)) if !rows.is_empty() => {
            let snapshot_msg = serde_json::json!({
                "query_id": query_id,
                "gen": my_gen,
                "inserted": rows,
                "deleted": [],
            });
            if ws_tx
                .send(Message::Text(snapshot_msg.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        Ok(Some(_)) => {}
        Ok(None) => {
            info!("generation changed before snapshot; closing (query_id={query_id})");
            let _ = ws_tx.send(Message::Close(None)).await;
            return;
        }
        Err(e) => {
            warn!("snapshot read failed for {query_id}: {e}; closing");
            let _ = ws_tx.send(Message::Close(None)).await;
            return;
        }
    }

    // 6. Receive loop: deliver only on EXACT generation match; a resubscribed
    //    notice of a different generation revokes this (stale) connection.
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(m) => {
                        if m.resubscribed {
                            // RevokeStale: an opaque-epoch token; only the exact
                            // announced generation survives.
                            if m.gen != Some(my_gen) {
                                info!("resubscribed gen mismatch; revoking stale WS (query_id={query_id})");
                                break;
                            }
                            continue; // matching gen: stay; never forward the notice
                        }
                        // delta / overflow / invalidated: drop a different-epoch message.
                        if let Some(g) = m.gen {
                            if g != my_gen {
                                continue;
                            }
                        }
                        if ws_tx.send(Message::Text(m.payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("client lagged by {n} messages, sending overflow");
                        let overflow = serde_json::json!({
                            "type": "overflow",
                            "query_id": query_id,
                            "gen": my_gen,
                            "fetch": true,
                        });
                        let _ = ws_tx.send(Message::Text(overflow.to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => { let _ = ws_tx.send(Message::Pong(data)).await; }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { info!("WebSocket error: {e}"); break; }
                }
            }
        }
    }

    // Clean up the broadcast channel when the last subscriber leaves.
    {
        let mut channels_write = channels.write().await;
        if let Some(tx) = channels_write.get(&query_id) {
            if tx.receiver_count() == 0 {
                channels_write.remove(&query_id);
            }
        }
    }
}
