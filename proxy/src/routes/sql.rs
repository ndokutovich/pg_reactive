use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;

use crate::state::AppState;

use subtle::ConstantTimeEq;

/// Constant-time string comparison to prevent timing attacks on key checks.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// POST /api/sql — execute raw SQL.
/// Requires service_role key (Authorization: Bearer <SERVICE_ROLE_KEY>).
pub async fn sql_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Require service_role key OR explicit ENABLE_SQL_ENDPOINT=true
    if !state.config.enable_sql_endpoint && !is_service_role(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "service_role key required for /api/sql (or set ENABLE_SQL_ENDPOINT=true)"})),
        );
    }

    let sql = match payload.get("sql").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing or empty sql field"})),
            );
        }
    };

    let upper = sql.trim_start().to_uppercase();
    let is_select = upper.starts_with("SELECT") || upper.starts_with("WITH");

    if is_select {
        let trimmed = sql.trim_end_matches(';');
        let wrapped = format!(
            "SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) AS data FROM ({}) t",
            trimmed
        );
        match sqlx::query_scalar::<sqlx::Postgres, serde_json::Value>(&wrapped)
            .fetch_one(&state.pg_pool)
            .await
        {
            Ok(rows) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "rows": rows}))),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            ),
        }
    } else {
        match sqlx::query(sql).execute(&state.pg_pool).await {
            Ok(result) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "rows_affected": result.rows_affected(),
                })),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            ),
        }
    }
}

/// Check if the request carries a valid service_role key.
fn is_service_role(state: &AppState, headers: &HeaderMap) -> bool {
    let srv_key = match &state.config.service_role_key {
        Some(k) => k,
        None => return false, // No service_role_key configured — deny all
    };

    // Check Authorization: Bearer <key> (constant-time comparison)
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            if constant_time_eq(token, srv_key) {
                return true;
            }
        }
    }

    // Check apikey header (constant-time comparison)
    if let Some(key) = headers.get("apikey").and_then(|v| v.to_str().ok()) {
        if constant_time_eq(key, srv_key) {
            return true;
        }
    }

    false
}
