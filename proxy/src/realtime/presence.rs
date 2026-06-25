use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

/// A presence row tagged with the GENERATION of the connection that wrote it.
/// Reads filter on generation so a client authorized for the current epoch never
/// sees presence written by a connection of another epoch — generation is an
/// opaque token, NOT comparable by order (SECURITY.md inv 17(f), round 39 batch-2
/// gen-ordering audit). Mirror of Go `realtime.presenceEntry`.
#[derive(Clone, Debug)]
struct PresenceEntry {
    state: Value,
    gen: i64,
}

/// Per-channel presence: channel -> client_id -> {state, generation}. Storage
/// only; the generation-gated fan-out of presence/broadcast events rides the same
/// per-query broadcast channel that deltas use, so a stale-epoch connection never
/// receives (or, via [`PresenceStore::list`], reads) another epoch's presence
/// (SECURITY.md inv 17(a)(f)). Mirror of the presence half of Go `realtime.Hub`.
#[derive(Clone, Default)]
pub struct PresenceStore {
    inner: Arc<RwLock<HashMap<String, HashMap<String, PresenceEntry>>>>,
}

impl PresenceStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register/refresh a client's presence under generation `gen`. Mirror of Go
    /// `PresenceJoin`/`PresenceUpdate` (the broadcast is done by the caller).
    pub async fn set(&self, channel: &str, client_id: &str, state: Value, gen: i64) {
        let mut map = self.inner.write().await;
        map.entry(channel.to_string())
            .or_default()
            .insert(client_id.to_string(), PresenceEntry { state, gen });
    }

    /// Remove a client's presence; drops the channel map when it empties. Mirror
    /// of Go `PresenceLeave` (removal is by client_id; generation only tags the
    /// leave broadcast, done by the caller).
    pub async fn leave(&self, channel: &str, client_id: &str) {
        let mut map = self.inner.write().await;
        if let Some(clients) = map.get_mut(channel) {
            clients.remove(client_id);
            if clients.is_empty() {
                map.remove(channel);
            }
        }
    }

    /// Presence state for a channel, restricted to entries written by connections
    /// of generation `gen`. A reader authorized for the current epoch must never
    /// see presence written under a different one (SECURITY.md inv 17(f)). Mirror
    /// of Go `PresenceList(channel, gen)`.
    pub async fn list(&self, channel: &str, gen: i64) -> HashMap<String, Value> {
        let map = self.inner.read().await;
        let mut out = HashMap::new();
        if let Some(clients) = map.get(channel) {
            for (id, entry) in clients {
                if entry.gen == gen {
                    out.insert(id.clone(), entry.state.clone());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // SECURITY.md inv 17(f) / round 39 batch-2 gen-ordering audit: presence is
    // stored with the writer's generation, and a read is restricted to the
    // caller's generation. A client authorized for one epoch must NEVER see
    // presence written under another — even when a stale-generation socket
    // lingers (the gen-ordering race can leave it un-revoked). Mirror of Go
    // TestPresenceList_FiltersByGeneration.
    #[tokio::test]
    async fn presence_list_filters_by_generation() {
        let store = PresenceStore::new();
        store
            .set("room-gen", "old-client", json!({"secret":"OLD"}), 5)
            .await;
        store
            .set("room-gen", "new-client", json!({"secret":"NEW"}), 6)
            .await;

        let list6 = store.list("room-gen", 6).await;
        assert!(
            !list6.contains_key("old-client"),
            "gen-5 presence leaked to a gen-6 reader"
        );
        assert!(
            list6.contains_key("new-client"),
            "gen-6 reader must see the gen-6 entry"
        );

        let list5 = store.list("room-gen", 5).await;
        assert!(
            !list5.contains_key("new-client"),
            "gen-6 presence leaked to a gen-5 reader"
        );
        assert!(
            list5.contains_key("old-client"),
            "gen-5 reader must see the gen-5 entry"
        );
    }

    #[tokio::test]
    async fn set_and_leave_roundtrip() {
        let store = PresenceStore::new();
        store.set("r", "a", json!({}), 0).await;
        store.set("r", "b", json!({"x":1}), 0).await;
        assert_eq!(store.list("r", 0).await.len(), 2);

        store.leave("r", "a").await;
        let list = store.list("r", 0).await;
        assert_eq!(list.len(), 1);
        assert!(list.contains_key("b"));

        // Last client leaving drops the channel map entry.
        store.leave("r", "b").await;
        assert!(store.list("r", 0).await.is_empty());
    }

    #[tokio::test]
    async fn list_is_empty_for_unknown_channel() {
        let store = PresenceStore::new();
        assert!(store.list("nope", 0).await.is_empty());
    }
}
