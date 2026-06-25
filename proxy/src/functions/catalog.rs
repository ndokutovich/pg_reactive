//! In-memory cache of `pgstack.edge_functions`, with a NOTIFY-driven refresh.
//!
//! Port of the Go reference `proxy-go/functions/catalog.go`. Loaded at startup
//! and reloaded whenever the `pgstack_fn_changed` trigger fires. Reads run on the
//! ADMIN pool: `pgstack.edge_functions` is `GRANT SELECT ... TO service_role`
//! only, so the data pool's `authenticator` role cannot see it.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use sqlx::{PgPool, Row};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::secrets::{decrypt_opt, SecretBox};

use super::http::validate_upstream_url;

/// A single edge function's configuration.
#[derive(Clone, Debug)]
pub struct FunctionMeta {
    pub name: String,
    /// "embedded" | "plv8" | "plpython3u" | "deno" | "http".
    pub runtime: String,
    pub verify_jwt: bool,
    pub status: String,
    pub code: String,
    /// Per-function HTTP target for runtime="http"; empty otherwise.
    pub upstream_url: String,
    /// Decrypted environment variables (never serialised back). Empty when the
    /// function has no env vars or `SECRETS_ENCRYPTION_KEY` is unset. Loaded for
    /// parity with Go `FunctionMeta.Env`: the reference proxy decrypts it on
    /// refresh but no runtime consumes it at dispatch yet, so it is read here
    /// only to drive the same decrypt/WARN behavior.
    #[allow(dead_code)]
    pub env: HashMap<String, String>,
}

/// Thread-safe in-memory cache. `get`/`list` are concurrent-read safe; `refresh`
/// swaps the map atomically under the write lock.
pub struct FunctionsCatalog {
    funcs: RwLock<HashMap<String, Arc<FunctionMeta>>>,
    /// Used to decrypt `env_vars_encrypted`. None when `SECRETS_ENCRYPTION_KEY`
    /// is unset — a function whose row has a non-NULL ciphertext loads WITHOUT
    /// env (with a WARN), so misconfiguration is loud but not fatal (mirror Go).
    secrets: Option<Arc<SecretBox>>,
}

const REFRESH_QUERY: &str = "SELECT name, runtime, verify_jwt, status, \
     COALESCE(code, '') AS code, \
     COALESCE(upstream_url, '') AS upstream_url, \
     env_vars_encrypted \
     FROM pgstack.edge_functions \
     WHERE status = 'active'";

impl FunctionsCatalog {
    pub fn new(secrets: Option<Arc<SecretBox>>) -> Self {
        Self {
            funcs: RwLock::new(HashMap::new()),
            secrets,
        }
    }

    /// (Re)load active edge functions from the database. Safe to call while
    /// handlers run; the swap is atomic.
    pub async fn refresh(&self, pool: &PgPool) -> Result<(), sqlx::Error> {
        let rows = sqlx::query(REFRESH_QUERY).fetch_all(pool).await?;

        let mut funcs: HashMap<String, Arc<FunctionMeta>> = HashMap::new();
        for row in rows {
            let name: String = row.get("name");
            let runtime: String = row.get("runtime");
            let verify_jwt: bool = row.get("verify_jwt");
            let status: String = row.get("status");
            let code: String = row.get("code");
            let upstream_url: String = row.get("upstream_url");
            let env_encrypted: Option<Vec<u8>> = row.get("env_vars_encrypted");

            let mut env: HashMap<String, String> = HashMap::new();
            if let Some(blob) = env_encrypted.as_ref().filter(|b| !b.is_empty()) {
                match decrypt_opt(self.secrets.as_deref(), blob) {
                    Ok(plain) if !plain.is_empty() => {
                        match serde_json::from_slice::<HashMap<String, String>>(&plain) {
                            Ok(m) => env = m,
                            Err(e) => warn!(
                                fn = %name, error = %e,
                                "functions: env_vars decrypted but not a JSON object; ignored"
                            ),
                        }
                    }
                    Ok(_) => {}
                    Err(e) => warn!(
                        fn = %name, error = %e,
                        "functions: env_vars_encrypted present but cannot be decrypted; loaded without env"
                    ),
                }
            }

            // Drop http functions with an unsafe/missing upstream so they become a
            // clean 404 rather than a live SSRF vector (SECURITY.md invariant 9).
            if runtime == "http" {
                if let Err(e) = validate_upstream_url(&upstream_url) {
                    warn!(
                        fn = %name, upstream = %upstream_url, error = %e,
                        "functions: dropping http function with invalid upstream_url"
                    );
                    continue;
                }
            }

            funcs.insert(
                name.clone(),
                Arc::new(FunctionMeta {
                    name,
                    runtime,
                    verify_jwt,
                    status,
                    code,
                    upstream_url,
                    env,
                }),
            );
        }

        let count = funcs.len();
        *self.funcs.write().await = funcs;
        info!(count, "edge functions catalog refreshed");
        Ok(())
    }

    pub async fn get(&self, name: &str) -> Option<Arc<FunctionMeta>> {
        self.funcs.read().await.get(name).cloned()
    }

    pub async fn list(&self) -> Vec<Arc<FunctionMeta>> {
        self.funcs.read().await.values().cloned().collect()
    }
}

/// Spawn a background task that LISTENs on `pgstack_fn_changed` and refreshes the
/// catalog on every notification. `listen_url` must be the admin DSN (a row read
/// needs service_role); `pool` is the admin pool used for the refresh query. The
/// listen connection only LISTENs (no privileges required). Retries every 5s on
/// error (mirror Go `StartAutoRefresh`/`listenLoop`).
pub fn spawn_auto_refresh(catalog: Arc<FunctionsCatalog>, pool: PgPool, listen_url: String) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = listen_loop(&catalog, &pool, &listen_url).await {
                warn!(error = %e, "functions catalog LISTEN loop error — retrying in 5s");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn listen_loop(
    catalog: &Arc<FunctionsCatalog>,
    pool: &PgPool,
    listen_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut listener = PgListener::connect(listen_url).await?;
    listener.listen("pgstack_fn_changed").await?;
    info!("functions catalog: listening for pgstack_fn_changed notifications");
    loop {
        let _ = listener.recv().await?;
        info!("functions catalog: change notification — refreshing");
        if let Err(e) = catalog.refresh(pool).await {
            warn!(error = %e, "functions catalog: auto-refresh failed");
        }
    }
}
