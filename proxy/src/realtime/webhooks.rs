//! WebhookManager — loads webhook subscriptions from `pgstack.webhooks`, listens
//! (via the PG listener) on the `pgstack_webhooks` NOTIFY channel, and delivers
//! signed payloads through an SSRF-guarded HTTP client.
//!
//! Port of the Go reference `proxy-go/realtime/webhooks.go` +
//! `webhook_client.go`. Security-critical parity points:
//!   * The signing secret is held in plaintext only in memory after Refresh
//!     decrypts `secret_encrypted`; a row whose secret cannot be decrypted is
//!     DROPPED (fail-closed) rather than delivered unsigned (Go round-8).
//!   * Every delivery resolves the host and refuses any non-public-unicast IP
//!     at dial time (DNS-rebinding defense), refuses redirects, and times out
//!     (Go `newWebhookHTTPClient`). See `webhook_url::is_public_unicast`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::Sha256;
use sqlx::{PgPool, Row};
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::realtime::webhook_url::{is_public_unicast, validate_webhook_url};
use crate::secrets::{decrypt_opt, SecretBox};

type HmacSha256 = Hmac<Sha256>;

/// A registered webhook from `pgstack.webhooks` (secret decrypted into memory).
#[derive(Clone, Debug)]
pub struct Webhook {
    pub id: String,
    pub url: String,
    pub events: Vec<String>,
    pub table_name: String,
    pub secret: String,
    pub active: bool,
}

/// Loads webhooks from the DB and delivers payloads. Cheap to `clone` (all
/// shared state is behind `Arc`).
#[derive(Clone)]
pub struct WebhookManager {
    pool: PgPool,
    secrets: Option<Arc<SecretBox>>,
    webhooks: Arc<RwLock<Vec<Webhook>>>,
    client: reqwest::Client,
}

/// Custom reqwest DNS resolver enforcing the delivery-time SSRF policy. Mirror
/// of Go's `Dialer.Control`: the public-unicast check runs once per resolution,
/// right before connect, and reqwest connects ONLY to addresses this returns —
/// closing the DNS-rebinding window where a name resolved to a public IP at
/// validate-time and to 127.0.0.1 / a private node at delivery-time.
struct SsrfResolver;

impl reqwest::dns::Resolve for SsrfResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            // Port 0 — reqwest substitutes the URL's real port. Mirrors the
            // contract of the custom-resolver API.
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let filtered: Vec<SocketAddr> = addrs.filter(|a| is_public_unicast(a.ip())).collect();
            if filtered.is_empty() {
                return Err(format!(
                    "webhook dial: {host} did not resolve to any public unicast IP"
                )
                .into());
            }
            let iter: Box<dyn Iterator<Item = SocketAddr> + Send> = Box::new(filtered.into_iter());
            Ok(iter)
        })
    }
}

/// Build the hardened HTTP client (refuses redirects, refuses non-public IPs via
/// `SsrfResolver`, connect/total timeouts). Mirror of Go `newWebhookHTTPClient`.
fn new_webhook_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(60))
        .dns_resolver(Arc::new(SsrfResolver))
        .build()
        .expect("failed to build webhook HTTP client")
}

/// Parsed `pgstack_webhooks` NOTIFY event (emitted by `pgstack.webhook_notify()`).
#[derive(Deserialize)]
struct WebhookEvent {
    #[serde(default)]
    table: String,
    #[serde(default)]
    event: String,
    #[serde(default)]
    record: Option<Box<RawValue>>,
    #[serde(default)]
    old_record: Option<Box<RawValue>>,
    #[serde(default)]
    oversized: bool,
}

/// Payload POSTed to webhook endpoints (omitempty on record/old_record, like Go).
#[derive(serde::Serialize)]
struct WebhookPayload<'a> {
    event: &'a str,
    table: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_record: Option<&'a RawValue>,
}

impl WebhookManager {
    /// Create a manager with a hardened HTTP client. `secrets` is `None` for
    /// deployments that never set `SECRETS_ENCRYPTION_KEY` (Create then refuses
    /// non-empty secrets; Refresh drops rows with an encrypted secret).
    pub fn new(pool: PgPool, secrets: Option<Arc<SecretBox>>) -> Self {
        Self {
            pool,
            secrets,
            webhooks: Arc::new(RwLock::new(Vec::new())),
            client: new_webhook_client(),
        }
    }

    /// Reload all active webhooks from the database. Fail-closed: a row whose
    /// `secret_encrypted` cannot be decrypted, or whose URL fails the SSRF
    /// policy, is dropped rather than delivered unsigned / to an unsafe target.
    pub async fn refresh(&self) -> Result<(), sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id::text AS id, url, events, table_name, secret_encrypted, active \
             FROM pgstack.webhooks WHERE active = true",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut hooks = Vec::new();
        let mut dropped = 0usize;
        for row in rows {
            let id: String = row.get("id");
            let url: String = row.get("url");
            let events: Vec<String> = row.get("events");
            let table_name: String = row.get("table_name");
            let secret_enc: Option<Vec<u8>> = row.get("secret_encrypted");
            let active: bool = row.get("active");

            // Decrypt the at-rest secret into in-memory plaintext for HMAC
            // signing. Fail-closed (Go round-8): rather than degrade to unsigned
            // delivery when the key is missing/rotated or the ciphertext is
            // tampered, drop the row.
            let mut secret = String::new();
            if let Some(enc) = secret_enc.as_ref() {
                if !enc.is_empty() {
                    match decrypt_opt(self.secrets.as_deref(), enc) {
                        Ok(plain) => secret = String::from_utf8_lossy(&plain).into_owned(),
                        Err(e) => {
                            warn!(
                                id = %id,
                                "webhooks refresh: secret_encrypted present but cannot be decrypted ({e}); dropping (set SECRETS_ENCRYPTION_KEY or re-create the webhook)"
                            );
                            dropped += 1;
                            continue;
                        }
                    }
                }
            }

            // Refresh-time SSRF guard: rows inserted directly via SQL, restored
            // from a backup, or imported via migration bypass CreateWebhook's
            // check. Drop unsafe URLs so delivery never sees them.
            if let Err(e) = validate_webhook_url(&url) {
                warn!(id = %id, url = %url, "webhooks refresh: dropping row with unsafe URL ({e})");
                dropped += 1;
                continue;
            }

            hooks.push(Webhook {
                id,
                url,
                events,
                table_name,
                secret,
                active,
            });
        }

        let count = hooks.len();
        *self.webhooks.write().await = hooks;
        info!(count, dropped, "webhooks refreshed");
        Ok(())
    }

    /// Parse a `pgstack_webhooks` NOTIFY payload and deliver to every matching
    /// registered webhook (async, with retry). Mirror of Go
    /// `DeliverFromWebhookNotify`.
    pub async fn deliver_from_webhook_notify(&self, payload: &str) {
        let ev: WebhookEvent = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(e) => {
                warn!(payload, "webhooks: invalid NOTIFY payload: {e}");
                return;
            }
        };
        if ev.table.is_empty() || ev.event.is_empty() {
            return;
        }
        if ev.oversized {
            warn!(
                table = %ev.table,
                event = %ev.event,
                "webhooks: row exceeded NOTIFY size limit — delivered without record body"
            );
        }

        let hooks = self.webhooks.read().await.clone();
        for wh in hooks {
            if !wh.active {
                continue;
            }
            if !matches_event(&wh.events, &ev.event) {
                continue;
            }
            if wh.table_name != "*" && !wh.table_name.eq_ignore_ascii_case(&ev.table) {
                continue;
            }

            // Serialize this webhook's body once; record/old_record dropped when
            // absent or literal JSON null (omitempty parity).
            let body = match serde_json::to_vec(&WebhookPayload {
                event: &ev.event,
                table: &ev.table,
                record: raw_or_none(ev.record.as_deref()),
                old_record: raw_or_none(ev.old_record.as_deref()),
            }) {
                Ok(b) => b,
                Err(e) => {
                    error!(webhook_id = %wh.id, "webhook: marshal payload: {e}");
                    continue;
                }
            };

            let client = self.client.clone();
            tokio::spawn(async move {
                deliver_with_retry(&client, &wh, &body).await;
            });
        }
    }
}

/// Returns `None` for an absent or literal-null raw value so the WebhookPayload's
/// `skip_serializing_if` drops the field (mirror of Go `nilIfJSONNull`).
fn raw_or_none(r: Option<&RawValue>) -> Option<&RawValue> {
    match r {
        Some(v) if v.get() != "null" && !v.get().is_empty() => Some(v),
        _ => None,
    }
}

fn matches_event(events: &[String], event: &str) -> bool {
    events
        .iter()
        .any(|e| e == "*" || e.eq_ignore_ascii_case(event))
}

/// Deliver with 3 attempts and exponential backoff (Go `deliverWithRetry`).
async fn deliver_with_retry(client: &reqwest::Client, wh: &Webhook, body: &[u8]) {
    // 3 attempts; backoff before attempts 2 and 3 (0s, 1s, 4s — Go delays[0..3]).
    let delays = [Duration::ZERO, Duration::from_secs(1), Duration::from_secs(4)];
    for (attempt, delay) in delays.iter().enumerate() {
        if !delay.is_zero() {
            tokio::time::sleep(*delay).await;
        }
        match deliver(client, wh, body).await {
            Ok(()) => {
                debug!(webhook_id = %wh.id, url = %wh.url, attempt = attempt + 1, "webhook delivered");
                return;
            }
            Err(e) => {
                warn!(webhook_id = %wh.id, url = %wh.url, attempt = attempt + 1, "webhook delivery failed: {e}");
            }
        }
    }
    error!(webhook_id = %wh.id, url = %wh.url, "webhook delivery failed after 3 attempts");
}

/// One delivery attempt: POST the body, HMAC-SHA256 sign when a secret is set,
/// fail on >= 300. Mirror of Go `deliver`.
async fn deliver(client: &reqwest::Client, wh: &Webhook, body: &[u8]) -> Result<(), String> {
    let mut req = client
        .post(&wh.url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "pgstack-webhooks/1.0")
        .body(body.to_vec());

    if !wh.secret.is_empty() {
        let mut mac = HmacSha256::new_from_slice(wh.secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(body);
        let sig = mac.finalize().into_bytes();
        let sig_hex: String = sig.iter().map(|b| format!("{b:02x}")).collect();
        req = req.header("X-Webhook-Signature", format!("sha256={sig_hex}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("POST {}: {e}", wh.url))?;
    let status = resp.status();
    if status.as_u16() >= 300 {
        return Err(format!("POST {} returned {}", wh.url, status.as_u16()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_event_wildcard_and_case() {
        assert!(matches_event(&["*".into()], "INSERT"));
        assert!(matches_event(&["insert".into()], "INSERT"));
        assert!(matches_event(&["INSERT".into()], "insert"));
        assert!(!matches_event(&["UPDATE".into()], "DELETE"));
        assert!(!matches_event(&[], "INSERT"));
    }

    #[test]
    fn raw_or_none_drops_null_and_empty() {
        let null: Box<RawValue> = RawValue::from_string("null".into()).unwrap();
        assert!(raw_or_none(Some(&null)).is_none());
        let obj: Box<RawValue> = RawValue::from_string(r#"{"id":1}"#.into()).unwrap();
        assert_eq!(raw_or_none(Some(&obj)).map(|v| v.get()), Some(r#"{"id":1}"#));
        assert!(raw_or_none(None).is_none());
    }

    // The payload framing matches Go WebhookPayload: record present, old_record
    // (JSON null) dropped by omitempty.
    #[test]
    fn payload_omitempty_matches_go() {
        let record: Box<RawValue> = RawValue::from_string(r#"{"id":42}"#.into()).unwrap();
        let null: Box<RawValue> = RawValue::from_string("null".into()).unwrap();
        let body = serde_json::to_string(&WebhookPayload {
            event: "INSERT",
            table: "orders",
            record: raw_or_none(Some(&record)),
            old_record: raw_or_none(Some(&null)),
        })
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["event"], "INSERT");
        assert_eq!(v["table"], "orders");
        assert_eq!(v["record"]["id"], 42);
        assert!(v.get("old_record").is_none(), "null old_record must be dropped");
    }
}
