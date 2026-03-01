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

/// Resolve the real client IP from proxy headers, falling back to the TCP peer.
///
/// Priority: X-Forwarded-For (first IP) > X-Real-IP > ConnectInfo socket addr.
fn resolve_client_ip(headers: &axum::http::HeaderMap, fallback: IpAddr) -> IpAddr {
    // 1. X-Forwarded-For: take the first (leftmost) IP in the comma-separated list
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = first.trim().parse::<IpAddr>() {
                return ip;
            }
        }
    }

    // 2. X-Real-IP
    if let Some(xri) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = xri.trim().parse::<IpAddr>() {
            return ip;
        }
    }

    // 3. Fall back to direct TCP connection address
    fallback
}

/// Middleware: reject auth requests that exceed the rate limit.
pub async fn rate_limit_auth(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Result<impl IntoResponse, AppError> {
    let client_ip = resolve_client_ip(request.headers(), addr.ip());
    if !state.auth_rate_limiter.check(client_ip).await {
        return Err(AppError::TooManyRequests(
            "too many requests, try again later".into(),
        ));
    }
    Ok(next.run(request).await)
}
