use axum::http::HeaderMap;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Row};
use subtle::ConstantTimeEq;
use tracing::debug;

use crate::auth::jwt;
use crate::error::AppError;
use crate::state::AppState;

/// Maximum size for claims_json passed to set_config (8 KB).
const MAX_CLAIMS_JSON_LEN: usize = 8192;

/// Constant-time string comparison to prevent timing attacks on key checks.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Represents the authenticated identity for a request.
/// Extracted from JWT, anon key, or service role key.
#[derive(Debug, Clone, Serialize)]
pub struct RequestClaims {
    /// PG role to SET LOCAL (anon, authenticated, service_role)
    pub role: String,
    /// User ID (from JWT sub claim), if authenticated
    pub sub: Option<String>,
    /// Email (from JWT), if present
    pub email: Option<String>,
    /// Full JWT claims as JSON string, for request.jwt.claims
    pub claims_json: String,
}

impl RequestClaims {
    /// Create claims for the anonymous role.
    pub fn anon() -> Self {
        Self {
            role: "anon".into(),
            sub: None,
            email: None,
            claims_json: r#"{"role":"anon"}"#.into(),
        }
    }

    /// Create claims for the service role (bypasses RLS).
    fn service_role() -> Self {
        Self {
            role: "service_role".into(),
            sub: None,
            email: None,
            claims_json: r#"{"role":"service_role"}"#.into(),
        }
    }

    /// Create claims from a validated JWT.
    /// SECURITY: JWTs are never allowed to claim service_role.
    /// Only direct API key comparison grants service_role.
    fn from_jwt(claims: &jwt::Claims) -> Self {
        let role = if claims.role == "service_role" {
            "authenticated".to_string()
        } else {
            claims.role.clone()
        };
        let claims_json = serde_json::to_string(claims).unwrap_or_default();
        Self {
            role,
            sub: Some(claims.sub.clone()),
            email: claims.email.clone(),
            claims_json,
        }
    }
}

/// Resolve request claims from headers.
///
/// Resolution order:
/// 1. Bearer token matching service_role_key -> service_role
/// 2. apikey header matching service_role_key -> service_role
/// 3. Bearer token as JWT -> validate -> authenticated claims
/// 4. Bearer token matching anon_key -> anon
/// 5. apikey header matching anon_key -> anon
/// 6. No valid auth + JWT_SECRET set -> 401
/// 7. No auth + JWT_SECRET not set -> anon (auth disabled)
pub fn resolve_claims(headers: &HeaderMap, state: &AppState) -> Result<RequestClaims, AppError> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let apikey_header = headers
        .get("apikey")
        .and_then(|v| v.to_str().ok());

    let bearer_token = auth_header.and_then(|h| h.strip_prefix("Bearer "));

    // 1. Check if bearer token is a service_role_key (constant-time comparison)
    if let Some(token) = bearer_token {
        if let Some(ref srk) = state.config.service_role_key {
            if constant_time_eq(token, srk) {
                debug!("request authenticated as service_role (bearer)");
                return Ok(RequestClaims::service_role());
            }
        }
    }

    // 2. Check if apikey header is service_role_key (constant-time comparison)
    if let Some(key) = apikey_header {
        if let Some(ref srk) = state.config.service_role_key {
            if constant_time_eq(key, srk) {
                debug!("request authenticated as service_role (apikey)");
                return Ok(RequestClaims::service_role());
            }
        }
    }

    // 3. Try to validate bearer token as JWT (before anon key fallback)
    if let Some(ref secret) = state.config.jwt_secret {
        if let Some(token) = bearer_token {
            match jwt::validate_token(token, secret) {
                Ok(claims) => {
                    debug!(sub = %claims.sub, role = %claims.role, "request authenticated via JWT");
                    return Ok(RequestClaims::from_jwt(&claims));
                }
                Err(_) => {
                    // Not a valid JWT — fall through to anon key checks
                }
            }
        }
    }

    // 4. Check if bearer token is anon_key (constant-time comparison)
    if let Some(token) = bearer_token {
        if let Some(ref ak) = state.config.anon_key {
            if constant_time_eq(token, ak) {
                debug!("request authenticated as anon (bearer)");
                return Ok(RequestClaims::anon());
            }
        }
    }

    // 5. Check if apikey header is anon_key (constant-time comparison)
    if let Some(key) = apikey_header {
        if let Some(ref ak) = state.config.anon_key {
            if constant_time_eq(key, ak) {
                debug!("request authenticated as anon (apikey)");
                return Ok(RequestClaims::anon());
            }
        }
    }

    // 6. Auth enabled but no valid credentials -> 401
    if state.config.jwt_secret.is_some() {
        return Err(AppError::Unauthorized("authentication required".into()));
    }

    // 6. Auth disabled (no JWT_SECRET) -> default to anon
    Ok(RequestClaims::anon())
}

/// Axum extractor: pulls RequestClaims from the request headers.
impl axum::extract::FromRequestParts<AppState> for RequestClaims {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let result = resolve_claims(&parts.headers, state);
        async move { result }
    }
}

/// Begin a PG transaction with RLS context (role + JWT claims) set.
///
/// Returns a transaction ready for use. The caller is responsible for
/// committing or rolling back. SET LOCAL values are automatically
/// reverted when the transaction ends.
///
/// Usage:
/// ```rust,ignore
/// let mut tx = rls_transaction(&pool, &claims).await?;
/// let rows = sqlx::query("SELECT * FROM todos")
///     .fetch_all(&mut *tx).await?;
/// tx.commit().await?;
/// ```
pub async fn rls_transaction(
    pool: &PgPool,
    claims: &RequestClaims,
) -> Result<sqlx::Transaction<'static, Postgres>, AppError> {
    let mut tx = pool.begin().await?;

    // SET LOCAL ROLE — switch effective PG role for this transaction.
    // Cannot use bind parameter with SET ROLE, so we whitelist valid roles.
    let role_sql = match claims.role.as_str() {
        "authenticated" => "SET LOCAL ROLE authenticated",
        "service_role" => "SET LOCAL ROLE service_role",
        _ => "SET LOCAL ROLE anon",
    };
    sqlx::query(role_sql)
        .execute(&mut *tx)
        .await?;

    // SET LOCAL request.jwt.claims — used by RLS policies.
    // Truncate to MAX_CLAIMS_JSON_LEN to prevent oversized GUC values.
    let truncated_claims = if claims.claims_json.len() > MAX_CLAIMS_JSON_LEN {
        &claims.claims_json[..MAX_CLAIMS_JSON_LEN]
    } else {
        &claims.claims_json
    };
    sqlx::query("SELECT set_config('request.jwt.claims', $1, true)")
        .bind(truncated_claims)
        .execute(&mut *tx)
        .await?;

    Ok(tx)
}

/// Execute a read-only query with RLS context and return JSON rows.
/// Convenience wrapper for simple SELECT queries on REST endpoints.
pub async fn rls_query_json(
    pool: &PgPool,
    claims: &RequestClaims,
    sql: &str,
    params: &[&(dyn sqlx::Encode<'_, Postgres> + Sync)],
) -> Result<Vec<serde_json::Value>, AppError> {
    let mut tx = rls_transaction(pool, claims).await?;

    // Wrap in row_to_json to get JSON output
    let wrapped = format!("SELECT row_to_json(t) as data FROM ({}) t", sql);
    let rows = sqlx::query(&wrapped)
        .fetch_all(&mut *tx)
        .await?;

    let result: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| row.get::<serde_json::Value, _>("data"))
        .collect();

    tx.commit().await?;
    Ok(result)
}
