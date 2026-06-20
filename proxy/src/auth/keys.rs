use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// SHA-256 hex of a token — matches the Go proxy's `HashToken`. Email and refresh
/// tokens are stored hashed at rest (SECURITY.md invariant 8): a DB/backup leak of
/// `pgstack.email_tokens`/`refresh_tokens` then yields no usable reset/session token.
pub fn hash_token(plain: &str) -> String {
    let sum = Sha256::digest(plain.as_bytes());
    let mut out = String::with_capacity(64);
    for b in sum {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Constant-time string comparison to prevent timing attacks.
/// Note: length difference is detectable via timing (acceptable for keys >= 32 chars).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Check if the request bears a valid service_role key.
pub fn is_service_role(headers: &axum::http::HeaderMap, service_role_key: &str) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|token| constant_time_eq(token, service_role_key))
}
