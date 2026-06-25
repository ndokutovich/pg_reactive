//! POST /rest/v1/batch — execute multiple REST operations in ONE PostgreSQL
//! transaction under a single RLS context.
//!
//! Faithful port of the Go proxy's `rest/batch.go`:
//! - `atomic: true` (default): one transaction, no savepoints; the first failure
//!   rolls the whole transaction back and returns HTTP 422 with the results up
//!   to and including the failed operation.
//! - `atomic: false`: a SAVEPOINT wraps each operation; a failure does
//!   ROLLBACK TO + records the error + continues, a success does RELEASE. The
//!   batch returns 207 if any operation failed, else 200.
//!
//! Every operation runs on the same transaction (one `SET LOCAL ROLE` + claims
//! for the whole batch), reusing the existing REST query builders. `{{opId.field}}`
//! templates cross-reference earlier operations' results.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Transaction};

use crate::error::AppError;
use crate::middleware::rls::{resolve_claims, rls_transaction};
use crate::rest::catalog::TableMeta;
use crate::rest::template::{resolve_templates, resolve_templates_in_string};
use crate::rest::{embed, handlers, query_builder, rpc};
use crate::state::AppState;

/// JSON request body for POST /rest/v1/batch.
#[derive(Deserialize)]
struct BatchRequest {
    /// Default true.
    atomic: Option<bool>,
    #[serde(default)]
    operations: Vec<BatchOperation>,
}

/// A single operation within a batch.
#[derive(Deserialize)]
struct BatchOperation {
    #[serde(default)]
    id: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    query: String,
    /// Raw JSON body, kept verbatim so `{{opId.field}}` templates resolve against
    /// the exact bytes (mirrors Go's `json.RawMessage`).
    #[serde(default)]
    body: Option<Box<serde_json::value::RawValue>>,
}

/// Result of a single batch operation.
#[derive(Serialize)]
struct BatchResult {
    id: String,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Complete response for POST /rest/v1/batch.
#[derive(Serialize)]
struct BatchResponse {
    results: Vec<BatchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_operation: Option<String>,
}

/// POST /rest/v1/batch handler.
pub async fn batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<axum::response::Response, AppError> {
    let mut req: BatchRequest = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("invalid JSON body".into()))?;

    if req.operations.is_empty() {
        return Err(AppError::BadRequest("batch: no operations".into()));
    }
    let max_ops = state.config.max_batch_operations;
    if req.operations.len() > max_ops {
        return Err(AppError::BadRequest(format!(
            "batch: too many operations (max {max_ops})"
        )));
    }

    // Validate (and normalise) every operation up front.
    for (i, op) in req.operations.iter_mut().enumerate() {
        if op.id.is_empty() {
            op.id = format!("op{i}");
        }
        let method = op.method.to_ascii_uppercase();
        match method.as_str() {
            "GET" | "POST" | "PATCH" | "DELETE" => op.method = method,
            _ => {
                return Err(AppError::BadRequest(format!(
                    "batch: operation {:?} has invalid method {:?}",
                    op.id, op.method
                )));
            }
        }
        if !op.path.starts_with("/rest/v1/") {
            return Err(AppError::BadRequest(format!(
                "batch: operation {:?} path must start with /rest/v1/",
                op.id
            )));
        }
    }

    // Resolve auth claims once for the entire batch (Go: 401 on any failure).
    let claims = resolve_claims(&headers, &state)
        .map_err(|_| AppError::Unauthorized("authentication required".into()))?;

    let atomic = req.atomic.unwrap_or(true);

    // Single RLS transaction — service_role routes to the admin pool.
    let mut tx = rls_transaction(state.pool_for(&claims.role), &claims).await?;

    let mut results_by_id: HashMap<String, Value> = HashMap::new();
    let mut results: Vec<BatchResult> = Vec::with_capacity(req.operations.len());
    let mut any_failed = false;

    for (i, op) in req.operations.iter().enumerate() {
        let result = execute_batch_op(&mut tx, &state, op, &results_by_id, atomic, i).await;

        if let Some(ref data) = result.data {
            results_by_id.insert(op.id.clone(), data.clone());
        }

        let failed = result.error.is_some();
        let err_msg = result.error.clone().unwrap_or_default();
        results.push(result);

        if failed {
            any_failed = true;
            if atomic {
                // Atomic mode: roll the whole transaction back.
                tx.rollback().await.ok();
                let resp = BatchResponse {
                    results,
                    error: Some(format!("operation {} failed: {}", op.id, err_msg)),
                    failed_operation: Some(op.id.clone()),
                };
                return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(resp)).into_response());
            }
            // Partial mode: the SAVEPOINT was already rolled back.
        }
    }

    tx.commit().await?;

    let status = if any_failed {
        StatusCode::MULTI_STATUS // 207
    } else {
        StatusCode::OK
    };
    let resp = BatchResponse {
        results,
        error: None,
        failed_operation: None,
    };
    Ok((status, Json(resp)).into_response())
}

/// Run a single operation, wrapping it in a SAVEPOINT in partial mode.
async fn execute_batch_op(
    tx: &mut Transaction<'static, Postgres>,
    state: &AppState,
    op: &BatchOperation,
    results_by_id: &HashMap<String, Value>,
    atomic: bool,
    idx: usize,
) -> BatchResult {
    let sp = format!("sp_{idx}");
    if !atomic
        && sqlx::query(&format!("SAVEPOINT {sp}"))
            .execute(&mut **tx)
            .await
            .is_err()
    {
        return BatchResult {
            id: op.id.clone(),
            status: 500,
            data: None,
            error: Some("savepoint failed".into()),
        };
    }

    match dispatch_batch_op(tx, state, op, results_by_id).await {
        Ok(result) => {
            if !atomic {
                let _ = sqlx::query(&format!("RELEASE {sp}"))
                    .execute(&mut **tx)
                    .await;
            }
            result
        }
        Err(e) => {
            if !atomic {
                let _ = sqlx::query(&format!("ROLLBACK TO {sp}"))
                    .execute(&mut **tx)
                    .await;
            }
            let (status, msg) = app_error_status(e);
            BatchResult {
                id: op.id.clone(),
                status,
                data: None,
                error: Some(msg),
            }
        }
    }
}

/// Parse the operation path and delegate to RPC or CRUD.
async fn dispatch_batch_op(
    tx: &mut Transaction<'static, Postgres>,
    state: &AppState,
    op: &BatchOperation,
    results_by_id: &HashMap<String, Value>,
) -> Result<BatchResult, AppError> {
    let path = op.path.strip_prefix("/rest/v1/").unwrap_or(&op.path);

    if let Some(fn_name) = path.strip_prefix("rpc/") {
        return batch_rpc(tx, state, op, fn_name, results_by_id).await;
    }
    batch_crud(tx, state, op, path, results_by_id).await
}

/// RPC call within a batch (templates resolved in the body first).
async fn batch_rpc(
    tx: &mut Transaction<'static, Postgres>,
    state: &AppState,
    op: &BatchOperation,
    fn_name: &str,
    results_by_id: &HashMap<String, Value>,
) -> Result<BatchResult, AppError> {
    let obj = match resolve_body(op, results_by_id)? {
        Some(s) if !s.trim().is_empty() => {
            let v: Value = serde_json::from_str(&s)
                .map_err(|_| AppError::BadRequest("invalid JSON body for RPC".into()))?;
            match v {
                Value::Object(m) => m,
                Value::Null => serde_json::Map::new(),
                _ => return Err(AppError::BadRequest("invalid JSON body for RPC".into())),
            }
        }
        _ => serde_json::Map::new(),
    };

    let data = rpc::execute_rpc(tx, &state.admin_pool, fn_name, &obj).await?;
    Ok(BatchResult {
        id: op.id.clone(),
        status: 200,
        data: Some(data),
        error: None,
    })
}

/// Table CRUD within a batch.
async fn batch_crud(
    tx: &mut Transaction<'static, Postgres>,
    state: &AppState,
    op: &BatchOperation,
    table_name: &str,
    results_by_id: &HashMap<String, Value>,
) -> Result<BatchResult, AppError> {
    let table = state
        .catalog
        .get_table(table_name)
        .await
        .ok_or_else(|| AppError::NotFound(format!("table not found: {table_name}")))?;

    // Resolve templates in the query string.
    let query_str = if op.query.is_empty() {
        String::new()
    } else {
        resolve_templates_in_string(&op.query, results_by_id)?
    };

    match op.method.as_str() {
        "GET" => batch_select(tx, state, op, &table, &query_str).await,
        "POST" => batch_insert(tx, op, &table, results_by_id).await,
        "PATCH" => batch_update(tx, op, &table, &query_str, results_by_id).await,
        "DELETE" => batch_delete(tx, op, &table, &query_str).await,
        other => Err(AppError::BadRequest(format!("unsupported method: {other}"))),
    }
}

async fn batch_select(
    tx: &mut Transaction<'static, Postgres>,
    state: &AppState,
    op: &BatchOperation,
    table: &TableMeta,
    query_str: &str,
) -> Result<BatchResult, AppError> {
    let query = crate::rest::filter::RestQuery::parse(Some(query_str))?;
    let embed_requests = embed::parse_embeds(query.select.as_deref());

    let rows = if embed_requests.is_empty() {
        let built = query_builder::build_select(table, &query)?;
        handlers::execute_select_json(tx, &built).await?
    } else {
        // Embed path: SELECT * in the base CTE so FK columns are available.
        let user_columns = query.select.clone();
        let mut base = query;
        base.select = None;
        let built = query_builder::build_select(table, &base)?;
        let mut resolved = Vec::with_capacity(embed_requests.len());
        for er in &embed_requests {
            resolved.push(embed::resolve_embed(&state.catalog, table, er).await?);
        }
        handlers::execute_select_with_embeds(tx, &built, table, &resolved, user_columns.as_deref())
            .await?
    };

    Ok(BatchResult {
        id: op.id.clone(),
        status: 200,
        data: Some(Value::Array(rows)),
        error: None,
    })
}

async fn batch_insert(
    tx: &mut Transaction<'static, Postgres>,
    op: &BatchOperation,
    table: &TableMeta,
    results_by_id: &HashMap<String, Value>,
) -> Result<BatchResult, AppError> {
    let raw = resolve_body(op, results_by_id)?
        .ok_or_else(|| AppError::BadRequest("invalid JSON body".into()))?;
    let body: Value = serde_json::from_str(&raw)
        .map_err(|_| AppError::BadRequest("invalid JSON body".into()))?;
    let is_array = body.is_array();

    let built = query_builder::build_insert(table, &body)?;
    let rows = handlers::execute_dml_json(tx, &built).await?;

    // Single-object insert -> unwrap to the object; array insert stays an array.
    let data = if is_array {
        Value::Array(rows)
    } else {
        rows.into_iter().next().unwrap_or(Value::Null)
    };

    Ok(BatchResult {
        id: op.id.clone(),
        status: 201,
        data: Some(data),
        error: None,
    })
}

async fn batch_update(
    tx: &mut Transaction<'static, Postgres>,
    op: &BatchOperation,
    table: &TableMeta,
    query_str: &str,
    results_by_id: &HashMap<String, Value>,
) -> Result<BatchResult, AppError> {
    let query = crate::rest::filter::RestQuery::parse(Some(query_str))?;
    if query.filters.is_empty() {
        return Err(AppError::BadRequest(
            "update requires at least one filter".into(),
        ));
    }

    let raw = resolve_body(op, results_by_id)?
        .ok_or_else(|| AppError::BadRequest("invalid JSON body".into()))?;
    let body: Value = serde_json::from_str(&raw)
        .map_err(|_| AppError::BadRequest("invalid JSON body".into()))?;

    let built = query_builder::build_update(table, &body, &query)?;
    let rows = handlers::execute_dml_json(tx, &built).await?;

    Ok(BatchResult {
        id: op.id.clone(),
        status: 200,
        data: Some(Value::Array(rows)),
        error: None,
    })
}

async fn batch_delete(
    tx: &mut Transaction<'static, Postgres>,
    op: &BatchOperation,
    table: &TableMeta,
    query_str: &str,
) -> Result<BatchResult, AppError> {
    let query = crate::rest::filter::RestQuery::parse(Some(query_str))?;
    if query.filters.is_empty() {
        return Err(AppError::BadRequest(
            "delete requires at least one filter".into(),
        ));
    }

    let built = query_builder::build_delete(table, &query)?;
    let rows = handlers::execute_dml_json(tx, &built).await?;

    Ok(BatchResult {
        id: op.id.clone(),
        status: 200,
        data: Some(Value::Array(rows)),
        error: None,
    })
}

/// Resolve `{{opId.field}}` templates in an operation's raw JSON body.
/// Returns `None` when the operation carries no body.
fn resolve_body(
    op: &BatchOperation,
    results_by_id: &HashMap<String, Value>,
) -> Result<Option<String>, AppError> {
    match op.body.as_ref().map(|b| b.get()) {
        Some(raw) => Ok(Some(resolve_templates(raw, results_by_id)?)),
        None => Ok(None),
    }
}

/// Map an `AppError` to the per-operation (status, message) recorded in a
/// `BatchResult` (mirrors Go's `pgHTTPStatus`; the message is already sanitised
/// for DB errors by `AppError`'s `From<sqlx::Error>`).
fn app_error_status(e: AppError) -> (u16, String) {
    match e {
        AppError::BadRequest(m) => (400, m),
        AppError::Unauthorized(m) => (401, m),
        AppError::Forbidden(m) => (403, m),
        AppError::NotFound(m) => (404, m),
        AppError::Conflict(m) => (409, m),
        AppError::PayloadTooLarge(m) => (413, m),
        AppError::TooManyRequests(m) => (429, m),
        AppError::ServiceUnavailable(m) => (503, m),
        AppError::Internal(m) => (500, m),
    }
}
