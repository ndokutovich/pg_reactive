use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;

use crate::auth::keys;
use crate::state::AppState;

/// POST /api/sql — execute raw SQL.
/// Requires service_role key (Authorization: Bearer <SERVICE_ROLE_KEY>).
pub async fn sql_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Require service_role key OR explicit ENABLE_SQL_ENDPOINT=true
    let has_service_role = state
        .config
        .service_role_key
        .as_deref()
        .is_some_and(|k| keys::is_service_role(&headers, k));
    if !state.config.enable_sql_endpoint && !has_service_role {
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
    // pgr. functions (subscribe, unsubscribe) do DML internally via SPI and
    // must not run inside a READ ONLY transaction.
    let calls_pgr = upper.contains("PGR.");
    let use_read_only = is_select && !calls_pgr;

    if use_read_only {
        let trimmed = sql.trim_end_matches(';');
        let wrapped = format!(
            "SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) AS data FROM ({}) t",
            trimmed
        );
        // Wrap in a read-only transaction so PostgreSQL itself rejects any
        // DML/DDL hidden inside CTEs (e.g. WITH x AS (DELETE ...) SELECT ...).
        let tx_result: Result<serde_json::Value, sqlx::Error> = async {
            let mut tx = state.pg_pool.begin().await?;
            sqlx::query("SET TRANSACTION READ ONLY")
                .execute(&mut *tx)
                .await?;
            let row = sqlx::query_scalar::<sqlx::Postgres, serde_json::Value>(&wrapped)
                .fetch_one(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(row)
        }
        .await;
        match tx_result {
            Ok(rows) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "rows": rows}))),
            Err(e) => {
                tracing::error!("SQL SELECT execution failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "SQL execution failed"})),
                )
            }
        }
    } else if is_select {
        // SELECT calling pgr. functions — run read-write (pgr funcs do DML internally).
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
            Err(e) => {
                tracing::error!("SQL SELECT (pgr) execution failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "SQL execution failed"})),
                )
            }
        }
    } else {
        let result = match sqlx::query(sql).execute(&state.pg_pool).await {
            Ok(result) => {
                // Auto-refresh catalog after DDL statements
                let trimmed_upper = sql.trim().to_uppercase();
                if trimmed_upper.starts_with("CREATE")
                    || trimmed_upper.starts_with("ALTER")
                    || trimmed_upper.starts_with("DROP")
                {
                    if let Err(e) = state.catalog.refresh(&state.pg_pool).await {
                        tracing::warn!("catalog refresh after DDL failed: {}", e);
                    }
                }

                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "ok": true,
                        "rows_affected": result.rows_affected(),
                    })),
                )
            }
            Err(e) => {
                tracing::error!("SQL execution failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "SQL execution failed"})),
                )
            }
        };
        result
    }
}
