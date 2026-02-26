use subtle::ConstantTimeEq;

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
        .map_or(false, |token| constant_time_eq(token, service_role_key))
}
