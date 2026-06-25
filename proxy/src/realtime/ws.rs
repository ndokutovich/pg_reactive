use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::middleware::rls::RequestClaims;
use crate::realtime::presence::PresenceStore;
use crate::state::{Channels, WsMessage};

/// Hard cap on a single client-to-server frame. A hostile client must not be
/// able to force the proxy to allocate an arbitrarily large buffer. Mirror of Go
/// `realtime.maxWSMessageBytes` (64 KiB; audit F4, 2026-05).
pub(crate) const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;

/// Bounds a single server-to-client write. Without a deadline a connection
/// wedged on a slow/stuck TCP write blocks this task indefinitely — so a
/// revoked socket (a `resubscribed` notice for a newer generation) would not
/// observe the revoke until the write returned, defeating the disconnect and
/// leaking the broadcast subscription. Mirrors the Go proxy's
/// `realtime.wsWriteWait` (round 39 batch-2 F-LIVENESS, SECURITY.md inv 17(d)).
const WS_WRITE_WAIT: Duration = Duration::from_secs(10);

/// Apply [`WS_WRITE_WAIT`] to a WS send future. A socket error OR a write that
/// exceeds the deadline both map to `Err(())`, which every caller treats as a
/// disconnect — turning a stuck write into a clean force-close (F-LIVENESS).
async fn bounded_send<Fut, E>(send: Fut) -> Result<(), ()>
where
    Fut: std::future::Future<Output = Result<(), E>>,
{
    bounded_send_within(WS_WRITE_WAIT, send).await
}

/// Inner form with an explicit deadline so the timeout/error mapping is unit-
/// testable without waiting the full [`WS_WRITE_WAIT`].
async fn bounded_send_within<Fut, E>(deadline: Duration, send: Fut) -> Result<(), ()>
where
    Fut: std::future::Future<Output = Result<(), E>>,
{
    match tokio::time::timeout(deadline, send).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(()), // socket-level write error → disconnect
        Err(_) => Err(()),     // deadline exceeded (wedged writer) → disconnect
    }
}

/// Proxy-reserved ad-hoc collaboration channels (catalog-less, public delta).
pub(crate) fn is_adhoc(query_id: &str) -> bool {
    query_id.starts_with("_channel_") || query_id.starts_with("_presence_")
}

/// A unique per-connection client id (16 random bytes, hex). Used to key presence
/// and stamp client broadcasts; the SERVER assigns it so a peer can't spoof
/// another's presence by sending a forged id. Mirror of Go `generateClientID`.
pub(crate) fn generate_client_id() -> String {
    use std::fmt::Write;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG (getrandom) unavailable");
    let mut s = String::with_capacity(32);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Publish a proxy-originated event (presence / client broadcast) onto the
/// per-query broadcast channel, stamped with the sender connection's generation.
/// The receive loop delivers a message only on EXACT generation match, so a
/// stale-epoch connection never receives a current peer's event — the SAME
/// generation gate deltas use (SECURITY.md inv 17(a)(f), round 39 batch-2 F2).
fn publish_gen(tx: &broadcast::Sender<WsMessage>, payload: String, gen: i64) {
    let _ = tx.send(WsMessage {
        gen: Some(gen),
        resubscribed: false,
        payload,
    });
}

/// One client-originated text frame, parsed and routed.
#[derive(serde::Deserialize)]
struct ClientFrame {
    #[serde(rename = "type")]
    kind: Option<String>,
    state: Option<serde_json::Value>,
    payload: Option<serde_json::Value>,
    // NOTE: any `client_id` in the frame is INTENTIONALLY ignored — the server
    // uses its handshake-assigned id so a peer cannot overwrite another's
    // presence (mirror of Go dispatchClientMessage).
}

/// Route a client text frame for `channel`, fanning presence/broadcast out
/// generation-gated. Exactly two shapes are accepted, mirroring Go
/// `dispatchClientMessage`:
///   - `{"type":"presence","state":{...}}`    → presence update (peer-state sync)
///   - `{"type":"broadcast","payload":<any>}` → wrapped as
///     `{"type":"broadcast","from":<clientID>,"payload":<orig>}` so a receiver
///     can't confuse it with a server delta.
///
/// Anything else (oversize, malformed, unknown/missing type) is dropped. Clients
/// can NOT forge server deltas/overflow/invalidated — those flow only from the PG
/// NOTIFY listener.
async fn dispatch_client_message(
    presence: &PresenceStore,
    tx: &broadcast::Sender<WsMessage>,
    channel: &str,
    client_id: &str,
    data: &[u8],
    gen: i64,
) {
    if data.len() > MAX_WS_MESSAGE_BYTES {
        warn!(
            "dropped client message: oversize ({} bytes) on {channel}",
            data.len()
        );
        return;
    }
    let frame: ClientFrame = match serde_json::from_slice(data) {
        Ok(f) => f,
        Err(_) => {
            debug!("dropped client message: malformed JSON on {channel}");
            return;
        }
    };
    match frame.kind.as_deref() {
        Some("presence") => {
            // Always key presence by the server-assigned client_id; routed to the
            // sender's generation so a stale peer never sees it (inv 17(f)).
            let state = frame.state.unwrap_or(serde_json::Value::Null);
            presence.set(channel, client_id, state.clone(), gen).await;
            let event = serde_json::json!({
                "type": "presence_state",
                "channel": channel,
                "client_id": client_id,
                "state": state,
            });
            publish_gen(tx, event.to_string(), gen);
        }
        Some("broadcast") => {
            let payload = frame.payload.unwrap_or(serde_json::Value::Null);
            let envelope = serde_json::json!({
                "type": "broadcast",
                "from": client_id,
                "payload": payload,
            });
            publish_gen(tx, envelope.to_string(), gen);
        }
        other => {
            debug!("dropped client message: unknown type {other:?} on {channel}");
        }
    }
}

/// Pure access-decision for the presence HTTP endpoint, shared with `main.rs`.
/// Returns `None` to allow, or `Some((status, msg))` to refuse. Identical policy
/// to the WS audience gate (mirror of Go `gatePresenceAccess`):
///   - empty audience           → public; allow.
///   - service_role             → always allow (admin bypass).
///   - audience set + anon       → 403 (anon never satisfies an audience).
///   - audience set + JWT match  → allow; mismatch → 403.
pub(crate) fn gate_presence_access(
    audience: &str,
    is_anon: bool,
    claims: &RequestClaims,
) -> Option<(axum::http::StatusCode, &'static str)> {
    use axum::http::StatusCode;
    if audience.is_empty() {
        return None;
    }
    if claims.role == "service_role" {
        return None;
    }
    if is_anon {
        return Some((StatusCode::FORBIDDEN, "channel requires an authenticated JWT"));
    }
    if claims.sub.is_none() || !claims_satisfy_audience(audience, &claims.claims_json) {
        return Some((
            StatusCode::FORBIDDEN,
            "JWT claims do not satisfy channel audience",
        ));
    }
    None
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
pub(crate) async fn subscription_meta(
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
pub(crate) fn claims_satisfy_audience(audience: &str, claims_json: &str) -> bool {
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
    let _ = bounded_send(ws_tx.send(Message::Text(err.to_string().into()))).await;
    let _ = bounded_send(ws_tx.send(Message::Close(None))).await;
}

/// Handle an established WebSocket connection for a given query_id, bound to the
/// generation it authorized against. `claims` is the connection's resolved
/// identity (role + sub + claims JSON) used for the audience gate.
#[allow(clippy::too_many_arguments)]
pub async fn handle_websocket(
    socket: WebSocket,
    query_id: String,
    channels: Channels,
    presence: PresenceStore,
    pg_pool: PgPool,
    broadcast_capacity: usize,
    claims: RequestClaims,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Server-assigned presence id (a peer can't spoof another's id — see
    // dispatch_client_message).
    let client_id = generate_client_id();

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

    // 3. Subscribe to the broadcast channel for this query_id. Keep a `tx` clone
    //    so presence/broadcast events this connection emits ride the SAME channel
    //    (and so the SAME generation gate) as deltas.
    let (mut rx, tx) = {
        let mut channels_write = channels.write().await;
        let tx = channels_write.entry(query_id.clone()).or_insert_with(|| {
            let (tx, _) = broadcast::channel(broadcast_capacity);
            tx
        });
        (tx.subscribe(), tx.clone())
    };

    // 4. Welcome.
    let welcome = serde_json::json!({ "type": "subscribed", "query_id": query_id });
    if bounded_send(ws_tx.send(Message::Text(welcome.to_string().into())))
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
            if bounded_send(ws_tx.send(Message::Text(snapshot_msg.to_string().into())))
                .await
                .is_err()
            {
                return;
            }
        }
        Ok(Some(_)) => {}
        Ok(None) => {
            info!("generation changed before snapshot; closing (query_id={query_id})");
            let _ = bounded_send(ws_tx.send(Message::Close(None))).await;
            return;
        }
        Err(e) => {
            warn!("snapshot read failed for {query_id}: {e}; closing");
            let _ = bounded_send(ws_tx.send(Message::Close(None))).await;
            return;
        }
    }

    // Presence join: register with empty state under this connection's
    // generation and announce it to same-generation peers (gen-gated fan-out,
    // inv 17(a)(f)). The join event also echoes back to this connection's own rx.
    presence
        .set(&query_id, &client_id, serde_json::json!({}), my_gen)
        .await;
    let join_event = serde_json::json!({
        "type": "presence_join",
        "channel": query_id,
        "client_id": client_id,
        "state": {},
    });
    publish_gen(&tx, join_event.to_string(), my_gen);

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
                        if bounded_send(ws_tx.send(Message::Text(m.payload.into()))).await.is_err() {
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
                        if bounded_send(ws_tx.send(Message::Text(overflow.to_string().into()))).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if bounded_send(ws_tx.send(Message::Pong(data))).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // Client-originated presence/broadcast — fanned out
                        // generation-gated. Clients CANNOT forge server
                        // deltas/overflow/invalidated (those come only from PG).
                        dispatch_client_message(
                            &presence, &tx, &query_id, &client_id, text.as_bytes(), my_gen,
                        )
                        .await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { info!("WebSocket error: {e}"); break; }
                }
            }
        }
    }

    // Presence leave: drop this client and announce it to same-generation peers
    // (gen-gated, inv 17(a)(f)).
    presence.leave(&query_id, &client_id).await;
    let leave_event = serde_json::json!({
        "type": "presence_leave",
        "channel": query_id,
        "client_id": client_id,
    });
    publish_gen(&tx, leave_event.to_string(), my_gen);

    // Clean up the broadcast channel when the last subscriber leaves.
    {
        let mut channels_write = channels.write().await;
        if let Some(ch_tx) = channels_write.get(&query_id) {
            if ch_tx.receiver_count() == 0 {
                channels_write.remove(&query_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // F-LIVENESS / SECURITY.md inv 17(d): a wedged writer must NOT pin the
    // connection task past the write deadline — it has to surface as an error so
    // the send loop disconnects. Uses a tiny injected deadline against a longer
    // sleep so the timeout path is exercised deterministically and fast.
    #[tokio::test]
    async fn bounded_send_times_out_on_wedged_write() {
        let wedged = async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok::<(), std::convert::Infallible>(())
        };
        assert!(
            bounded_send_within(Duration::from_millis(10), wedged)
                .await
                .is_err(),
            "a write exceeding the deadline must report an error (disconnect)"
        );
    }

    // The real send path uses the full WS_WRITE_WAIT.
    #[test]
    fn ws_write_wait_matches_go_deadline() {
        assert_eq!(WS_WRITE_WAIT, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn bounded_send_passes_success_and_propagates_error() {
        let ok = async { Ok::<(), std::convert::Infallible>(()) };
        assert!(bounded_send(ok).await.is_ok());

        let failed = async { Err::<(), &str>("socket closed") };
        assert!(bounded_send(failed).await.is_err());
    }
}
