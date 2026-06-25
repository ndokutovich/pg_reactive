use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use sqlx::PgPool;
use tokio::sync::{broadcast, RwLock, Semaphore};

use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::rest::catalog::Catalog;

/// A fan-out message for a query_id's subscribers, carrying the GENERATION the
/// NOTIFY was computed under (SECURITY.md invariants 15-17). Each connection is
/// bound to the committed catalog generation it authorized against and accepts a
/// message only on EXACT generation match; a `resubscribed` notice with a
/// different generation revokes a stale connection (RevokeStale).
#[derive(Clone, Debug)]
pub struct WsMessage {
    /// Generation stamped in the NOTIFY (`"gen":N`); None when absent.
    pub gen: Option<i64>,
    /// True for a `{"type":"resubscribed"}` notice — proxy-consumed (drives
    /// RevokeStale), never forwarded to the client.
    pub resubscribed: bool,
    /// Raw JSON payload to forward (delta / overflow / invalidated).
    pub payload: String,
}

/// Per-query broadcast sender. One query_id -> N WebSocket clients.
pub type Channels = Arc<RwLock<HashMap<String, broadcast::Sender<WsMessage>>>>;

/// Per-source-IP cap on concurrent WebSocket connections, so a single client
/// cannot exhaust the global `ws_semaphore` pool. Mirror of Go
/// `middleware.WSConnLimiter` (round 22): a slot is reserved when a connection
/// is admitted and released exactly once when the held `WsConnGuard` is dropped
/// (connection close). `max_per_ip == 0` disables the cap (passthrough).
pub struct WsConnLimiter {
    max_per_ip: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

impl WsConnLimiter {
    pub fn new(max_per_ip: usize) -> Arc<Self> {
        Arc::new(Self {
            max_per_ip,
            counts: Mutex::new(HashMap::new()),
        })
    }

    /// Reserve a slot for `ip`. Returns `None` when the IP is already at the cap
    /// (caller should answer 429). When the cap is disabled (`max_per_ip == 0`)
    /// a non-counting guard is returned so the connection always proceeds.
    pub fn try_acquire(self: &Arc<Self>, ip: IpAddr) -> Option<WsConnGuard> {
        if self.max_per_ip == 0 {
            return Some(WsConnGuard {
                limiter: self.clone(),
                ip,
                counted: false,
            });
        }
        let mut counts = self.counts.lock().unwrap();
        let c = counts.entry(ip).or_insert(0);
        if *c >= self.max_per_ip {
            return None;
        }
        *c += 1;
        Some(WsConnGuard {
            limiter: self.clone(),
            ip,
            counted: true,
        })
    }

    /// Current open-connection count for an IP. Test helper.
    #[cfg(test)]
    pub fn count(&self, ip: IpAddr) -> usize {
        self.counts.lock().unwrap().get(&ip).copied().unwrap_or(0)
    }
}

/// RAII slot held for a WebSocket connection's lifetime. Dropping it releases
/// the per-IP slot exactly once (mirrors Go's `wsTrackedConn.Close`).
pub struct WsConnGuard {
    limiter: Arc<WsConnLimiter>,
    ip: IpAddr,
    counted: bool,
}

impl Drop for WsConnGuard {
    fn drop(&mut self) {
        if !self.counted {
            return;
        }
        let mut counts = self.limiter.counts.lock().unwrap();
        if let Some(c) = counts.get_mut(&self.ip) {
            *c -= 1;
            if *c == 0 {
                counts.remove(&self.ip);
            }
        }
    }
}

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
    /// Separate, more generous bucket for /auth/v1/anonymous (stateless mint).
    pub anonymous_rate_limiter: RateLimiter,
    /// Global cap on concurrent WebSocket connections (process-wide).
    pub ws_semaphore: Arc<Semaphore>,
    /// Per-source-IP cap on concurrent WebSocket connections (in addition to the
    /// global `ws_semaphore`), mirroring Go's WSConnLimiter.
    pub ws_conn_limiter: Arc<WsConnLimiter>,
    /// SMTP mailer (logs to console when SMTP not configured).
    pub mailer: Arc<crate::auth::mailer::Mailer>,
}

impl AppState {
    pub fn new(config: Config, pg_pool: PgPool, admin_pool: PgPool) -> Self {
        let rate_limiter = RateLimiter::new(config.auth_rate_limit, config.auth_rate_window_secs);
        let anonymous_rate_limiter =
            RateLimiter::new(config.anonymous_rate_limit, config.anonymous_rate_window_secs);
        let ws_semaphore = Arc::new(Semaphore::new(config.max_connections));
        let ws_conn_limiter = WsConnLimiter::new(config.ws_max_per_ip);
        let mailer = Arc::new(crate::auth::mailer::Mailer::from_env());
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            config,
            pg_connected: Arc::new(AtomicBool::new(false)),
            pg_pool,
            admin_pool,
            catalog: Catalog::new(),
            auth_rate_limiter: rate_limiter,
            anonymous_rate_limiter,
            ws_semaphore,
            ws_conn_limiter,
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

#[cfg(test)]
mod tests {
    use super::*;

    // ITEM H (parity with Go middleware.WSConnLimiter, round 22): the N+1th
    // concurrent connection from one IP is refused while a different IP and the
    // global pool are unaffected; releasing a guard frees the slot.
    #[test]
    fn ws_conn_limiter_caps_per_ip_and_releases_on_drop() {
        let limiter = WsConnLimiter::new(2);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let other: IpAddr = "10.0.0.2".parse().unwrap();

        let g1 = limiter.try_acquire(ip);
        let g2 = limiter.try_acquire(ip);
        assert!(g1.is_some() && g2.is_some());
        assert_eq!(limiter.count(ip), 2);

        // 3rd from the same IP is refused...
        assert!(limiter.try_acquire(ip).is_none());
        // ...but a different IP still gets a slot (per-IP, not global).
        assert!(limiter.try_acquire(other).is_some_and(|g| {
            drop(g);
            true
        }));

        // Releasing one frees exactly one slot.
        drop(g2);
        assert_eq!(limiter.count(ip), 1);
        assert!(limiter.try_acquire(ip).is_some());

        drop(g1);
    }

    // max_per_ip == 0 disables the cap (passthrough), mirroring Go's
    // `maxPerIP <= 0` early return.
    #[test]
    fn ws_conn_limiter_zero_disables_cap() {
        let limiter = WsConnLimiter::new(0);
        let ip: IpAddr = "10.0.0.3".parse().unwrap();
        let guards: Vec<_> = (0..100).filter_map(|_| limiter.try_acquire(ip)).collect();
        assert_eq!(guards.len(), 100, "disabled cap must admit every connection");
        // Disabled cap never counts, so the map stays empty.
        assert_eq!(limiter.count(ip), 0);
    }
}
