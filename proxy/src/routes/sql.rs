use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::state::AppState;

/// POST /api/sql — execute raw SQL (tutorial/dev only).
pub async fn sql_execute(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
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
