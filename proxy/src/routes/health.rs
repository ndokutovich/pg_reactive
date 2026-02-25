use std::sync::atomic::Ordering;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::state::AppState;

/// GET /health
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let pg_ok = state.pg_connected.load(Ordering::Relaxed);
    let status = if pg_ok { "ok" } else { "degraded" };
    let code = if pg_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        code,
        Json(serde_json::json!({
            "status": status,
            "pg_connected": pg_ok,
        })),
    )
}
