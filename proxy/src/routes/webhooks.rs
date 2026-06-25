//! Webhook CRUD — POST/GET/DELETE `/rest/v1/webhooks`. service_role only.
//!
//! Port of the Go reference `proxy-go/routes/webhooks.go`. The signing secret is
//! AES-256-GCM-encrypted before it lands in `pgstack.webhooks.secret_encrypted`
//! and returned plaintext exactly ONCE, in the create response — Get/List return
//! only a `secret_set` flag (SECURITY.md trust matrix "Webhook CRUD" row).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use sqlx::Row;
use tracing::{error, warn};

use crate::error::AppError;
use crate::middleware::rls::RequestClaims;
use crate::realtime::webhook_url::validate_webhook_url;
use crate::secrets::encrypt_opt;
use crate::state::AppState;

/// Reject anything but a service_role caller. `RequestClaims` already 401s when
/// auth is enabled and no valid credential is presented (mirror of Go
/// ResolveClaims → 401, then role check → 403).
fn require_service_role(claims: &RequestClaims) -> Result<(), AppError> {
    if claims.role != "service_role" {
        return Err(AppError::Forbidden(
            "webhook management requires service_role".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateWebhookBody {
    #[serde(default)]
    url: String,
    #[serde(default)]
    events: Vec<String>,
    #[serde(default)]
    table_name: String,
    #[serde(default)]
    secret: String,
}

/// POST /rest/v1/webhooks — create a webhook (service_role only).
pub async fn create_webhook(
    State(state): State<AppState>,
    claims: RequestClaims,
    Json(mut body): Json<CreateWebhookBody>,
) -> Result<impl IntoResponse, AppError> {
    require_service_role(&claims)?;

    if body.url.is_empty() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    // SSRF guard — even a privileged caller cannot point the webhook at internal
    // nodes, the cloud metadata server, or loopback.
    validate_webhook_url(&body.url).map_err(AppError::BadRequest)?;

    if body.events.is_empty() {
        body.events = vec!["*".into()];
    }
    if body.table_name.is_empty() {
        body.table_name = "*".into();
    }

    // Encrypt the signing secret before persisting. Non-empty without a
    // configured key = refuse (storing plaintext would re-open the F1 hole).
    let secret_enc: Option<Vec<u8>> = if body.secret.is_empty() {
        None
    } else {
        if state.secrets.is_none() {
            return Err(AppError::BadRequest(
                "webhook secret cannot be stored: SECRETS_ENCRYPTION_KEY is not configured".into(),
            ));
        }
        match encrypt_opt(state.secrets.as_deref(), body.secret.as_bytes()) {
            Ok(enc) => Some(enc),
            Err(e) => {
                error!("webhooks: encrypt secret: {e}");
                return Err(AppError::Internal("internal error encrypting secret".into()));
            }
        }
    };

    let row = sqlx::query(
        "INSERT INTO pgstack.webhooks (url, events, table_name, secret_encrypted) \
         VALUES ($1, $2, $3, $4) RETURNING id::text AS id, created_at::text AS created_at",
    )
    .bind(&body.url)
    .bind(&body.events)
    .bind(&body.table_name)
    .bind(secret_enc.as_deref())
    .fetch_one(&state.admin_pool)
    .await
    .map_err(|e| {
        error!("webhooks: create: {e}");
        AppError::Internal("internal database error".into())
    })?;
    let id: String = row.get("id");
    let created_at: String = row.get("created_at");

    // Install the AFTER ROW trigger that feeds 'pgstack_webhooks'. "*" is a
    // wildcard matcher only — it cannot install a trigger and relies on the
    // triggers installed by table-specific webhooks.
    if body.table_name != "*" {
        if let Err(e) = sqlx::query("SELECT pgstack.enable_webhook_trigger($1::regclass)")
            .bind(&body.table_name)
            .execute(&state.admin_pool)
            .await
        {
            error!(table = %body.table_name, "webhooks: enable trigger: {e}");
            // Roll back the orphan row so we never have a webhook with no
            // trigger feeding it.
            let _ = sqlx::query("DELETE FROM pgstack.webhooks WHERE id = $1::uuid")
                .bind(&id)
                .execute(&state.admin_pool)
                .await;
            return Err(AppError::BadRequest(format!(
                "failed to install webhook trigger on table: {}",
                body.table_name
            )));
        }
    }

    if let Err(e) = state.webhook_manager.refresh().await {
        warn!("webhooks: refresh after create failed: {e}");
    }

    // Secret returned ONCE here — List/Get never reveal it.
    let resp = serde_json::json!({
        "id": id,
        "url": body.url,
        "events": body.events,
        "table_name": body.table_name,
        "secret": body.secret,
        "active": true,
        "created_at": created_at,
    });
    Ok((StatusCode::CREATED, Json(resp)))
}

/// GET /rest/v1/webhooks — list webhooks (service_role only). The secret value is
/// never selected; `secret_set` reports whether a row has one.
pub async fn list_webhooks(
    State(state): State<AppState>,
    claims: RequestClaims,
) -> Result<impl IntoResponse, AppError> {
    require_service_role(&claims)?;

    let rows = sqlx::query(
        "SELECT id::text AS id, url, events, table_name, \
         (secret_encrypted IS NOT NULL) AS secret_set, active, created_at::text AS created_at \
         FROM pgstack.webhooks ORDER BY created_at",
    )
    .fetch_all(&state.admin_pool)
    .await
    .map_err(|e| {
        error!("webhooks: list: {e}");
        AppError::Internal("internal database error".into())
    })?;

    let result: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            let events: Vec<String> = row.get("events");
            serde_json::json!({
                "id": row.get::<String, _>("id"),
                "url": row.get::<String, _>("url"),
                "events": events,
                "table_name": row.get::<String, _>("table_name"),
                "secret_set": row.get::<bool, _>("secret_set"),
                "active": row.get::<bool, _>("active"),
                "created_at": row.get::<String, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(result))
}

/// DELETE /rest/v1/webhooks/{id} — delete a webhook (service_role only).
pub async fn delete_webhook(
    State(state): State<AppState>,
    claims: RequestClaims,
    Path(webhook_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    require_service_role(&claims)?;

    if webhook_id.is_empty() {
        return Err(AppError::BadRequest("webhook id is required".into()));
    }

    let deleted: Option<(String,)> =
        sqlx::query_as("DELETE FROM pgstack.webhooks WHERE id = $1::uuid RETURNING table_name")
            .bind(&webhook_id)
            .fetch_optional(&state.admin_pool)
            .await
            .map_err(|e| {
                error!("webhooks: delete: {e}");
                AppError::Internal("internal database error".into())
            })?;

    let deleted_table = match deleted {
        Some((t,)) => t,
        None => return Err(AppError::NotFound("webhook not found".into())),
    };

    // Drop the per-table trigger once no active webhook references the table.
    if deleted_table != "*" {
        let remaining: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pgstack.webhooks WHERE table_name = $1 AND active = true",
        )
        .bind(&deleted_table)
        .fetch_one(&state.admin_pool)
        .await
        .unwrap_or(0);
        if remaining == 0 {
            if let Err(e) = sqlx::query("SELECT pgstack.disable_webhook_trigger($1::regclass)")
                .bind(&deleted_table)
                .execute(&state.admin_pool)
                .await
            {
                warn!(table = %deleted_table, "webhooks: disable trigger: {e}");
            }
        }
    }

    if let Err(e) = state.webhook_manager.refresh().await {
        warn!("webhooks: refresh after delete failed: {e}");
    }

    Ok(Json(serde_json::json!({ "message": "webhook deleted" })))
}
