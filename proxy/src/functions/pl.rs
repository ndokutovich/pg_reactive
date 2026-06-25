//! runtime="plv8" / "plpython3u" — PostgreSQL-hosted edge functions.
//!
//! Port of the Go reference `proxy-go/functions/functions.go` `invokePLRuntime`.
//! Both runtimes share one calling convention from the proxy side: the function
//! is `pgstack.fn_{name}(body jsonb) RETURNS jsonb`, called inside an RLS
//! transaction so the caller's role + claims apply (SECURITY-context aware). The
//! only difference between plv8 and plpython3u is the SQL function body's
//! language, which is invisible here.

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sqlx::Row;
use tracing::error;

use crate::error::AppError;
use crate::middleware::rls::{rls_transaction, RequestClaims};
use crate::rest::query_builder::quote_ident;
use crate::state::AppState;

/// Call `pgstack.fn_{name}(body jsonb)` via an RLS transaction and return its
/// JSON result. `schema` is "pgstack" for both PL runtimes.
pub async fn invoke_pl_runtime(
    state: &AppState,
    fn_name: &str,
    body_bytes: Bytes,
    claims: &RequestClaims,
    schema: &str,
) -> Response {
    // Default an empty body to `{}` (mirror Go) and reject non-JSON bodies.
    let body: Vec<u8> = if body_bytes.is_empty() {
        b"{}".to_vec()
    } else {
        body_bytes.to_vec()
    };
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return super::json_error(StatusCode::BAD_REQUEST, "invalid JSON body");
    }
    let body_str = String::from_utf8_lossy(&body).into_owned();

    let pg_fn = format!("fn_{fn_name}");
    let sql = format!(
        "SELECT to_json({}.{}($1::jsonb)) AS data",
        quote_ident(schema),
        quote_ident(&pg_fn),
    );

    let pool = state.pool_for(&claims.role);
    let mut tx = match rls_transaction(pool, claims).await {
        Ok(tx) => tx,
        Err(e) => {
            error!(fn = %fn_name, "functions: begin RLS transaction failed");
            return e.into_response();
        }
    };

    let row = match sqlx::query(&sql).bind(&body_str).fetch_one(&mut *tx).await {
        Ok(r) => r,
        Err(e) => {
            error!(fn = %fn_name, error = %e, "functions: PL runtime execution failed");
            // From<sqlx::Error> maps SQLSTATE → HTTP status (23505→409, 42501→403,
            // 42*/22*/23*→4xx, else 500) — the same policy as Go pgHTTPStatus.
            let ae: AppError = e.into();
            return ae.into_response();
        }
    };
    let data: serde_json::Value = row.get("data");

    if let Err(e) = tx.commit().await {
        error!(fn = %fn_name, "functions: commit failed");
        let ae: AppError = e.into();
        return ae.into_response();
    }

    (StatusCode::OK, Json(data)).into_response()
}
