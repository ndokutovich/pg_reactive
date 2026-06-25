use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::IntoResponse;
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::state::AppState;

/// In-memory sliding-window rate limiter.
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
    max_requests: usize,
    window: Duration,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            max_requests,
            window: Duration::from_secs(window_secs),
        }
    }

    pub async fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.inner.lock().await;
        let now = Instant::now();
        let entries = map.entry(ip).or_default();
        // Remove entries outside the window
        entries.retain(|t| now.duration_since(*t) < self.window);
        if entries.len() >= self.max_requests {
            return false;
        }
        entries.push(now);
        true
    }
}

/// Resolve the real client IP (SECURITY.md invariant 4). Forwarded headers are
/// honoured ONLY when the immediate TCP peer is a configured trusted proxy;
/// otherwise the kernel-attested peer address is used and `X-Forwarded-For` is
/// ignored (a client could otherwise spoof XFF to evade the rate limiter).
/// `X-Real-IP` is NEVER honoured. The XFF chain is walked right-to-left, skipping
/// trusted-proxy hops, so the nginx `$proxy_add_x_forwarded_for` append can't be
/// spoofed by prepending attacker IPs.
pub(crate) fn resolve_client_ip(
    headers: &axum::http::HeaderMap,
    fallback: IpAddr,
    trusted: &[IpAddr],
) -> IpAddr {
    // No trusted proxies configured, or the immediate peer is not one → never
    // trust forwarded headers.
    if trusted.is_empty() || !trusted.contains(&fallback) {
        return fallback;
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        for part in xff.split(',').rev() {
            if let Ok(ip) = part.trim().parse::<IpAddr>() {
                if !trusted.contains(&ip) {
                    return ip;
                }
            }
        }
    }
    fallback
}

/// Parse the configured TRUSTED_PROXIES into IPs (XFF is honoured only from
/// these — SECURITY.md invariant 4).
fn trusted_proxies(state: &AppState) -> Vec<IpAddr> {
    state
        .config
        .trusted_proxies
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}

/// Middleware: reject auth requests that exceed the rate limit.
pub async fn rate_limit_auth(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Result<impl IntoResponse, AppError> {
    let trusted = trusted_proxies(&state);
    let client_ip = resolve_client_ip(request.headers(), addr.ip(), &trusted);
    if !state.auth_rate_limiter.check(client_ip).await {
        return Err(AppError::TooManyRequests(
            "too many requests, try again later".into(),
        ));
    }
    Ok(next.run(request).await)
}

/// Middleware: rate-limit /auth/v1/anonymous in its own (more generous) bucket.
/// Mirrors Go's `state.AnonymousLimiter` group — the endpoint mints a stateless
/// throw-away JWT (no DB write, no email), so it gets a separate, larger limit
/// than signup/token to allow public guest-token demos.
pub async fn rate_limit_anonymous(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Result<impl IntoResponse, AppError> {
    let trusted = trusted_proxies(&state);
    let client_ip = resolve_client_ip(request.headers(), addr.ip(), &trusted);
    if !state.anonymous_rate_limiter.check(client_ip).await {
        return Err(AppError::TooManyRequests(
            "too many requests, try again later".into(),
        ));
    }
    Ok(next.run(request).await)
}
