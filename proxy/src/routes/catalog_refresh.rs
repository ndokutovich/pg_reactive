use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::error::AppError;
use crate::middleware::rls::RequestClaims;
use crate::state::AppState;

/// POST /api/catalog/refresh — force-reload the REST catalog from pg_catalog.
/// Restricted to service_role only.
pub async fn catalog_refresh(
    State(state): State<AppState>,
    claims: RequestClaims,
) -> Result<impl IntoResponse, AppError> {
    if claims.role != "service_role" {
        return Err(AppError::Forbidden(
            "catalog refresh requires service_role".into(),
        ));
    }

    state
        .catalog
        .refresh(&state.pg_pool)
        .await
        .map_err(|e| AppError::Internal(format!("catalog refresh failed: {e}")))?;

    Ok(Json(json!({ "ok": true })))
}
