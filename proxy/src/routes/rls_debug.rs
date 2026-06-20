use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use sqlx::Row;

use crate::error::AppError;
use crate::middleware::rls::{rls_transaction, RequestClaims};
use crate::state::AppState;

/// GET /rest/v1/rls-debug — return the current PG role and JWT claims as seen by PG.
/// Useful for debugging RLS policies.
/// Restricted to service_role only.
pub async fn rls_debug(
    State(state): State<AppState>,
    claims: RequestClaims,
) -> Result<impl IntoResponse, AppError> {
    // Only service_role may access this debug endpoint
    if claims.role != "service_role" {
        return Err(AppError::Forbidden(
            "rls-debug requires service_role".into(),
        ));
    }

    let mut tx = rls_transaction(state.pool_for(&claims.role), &claims).await?;

    let row = sqlx::query(
        "SELECT current_setting('role') as pg_role,
                current_setting('request.jwt.claims', true) as jwt_claims",
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    let pg_role: String = row.get("pg_role");
    let jwt_claims: Option<String> = row.get("jwt_claims");
    let parsed_claims: serde_json::Value = jwt_claims
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!(null));

    Ok(Json(json!({
        "pg_role": pg_role,
        "jwt_claims": parsed_claims,
        "request_role": claims.role,
        "request_sub": claims.sub,
    })))
}
