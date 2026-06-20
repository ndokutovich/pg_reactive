use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::error;

/// Unified error type for all proxy handlers.
#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    TooManyRequests(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
            AppError::TooManyRequests(msg) => (StatusCode::TOO_MANY_REQUESTS, msg),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        let body = serde_json::json!({ "error": message });
        (status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::RowNotFound => AppError::NotFound("not found".into()),
            sqlx::Error::Database(db_err) => {
                // Log full error server-side for debugging
                let code = db_err.code().unwrap_or_default();
                error!(pg_code = %code, "database error: {}", db_err.message());

                // Return sanitized messages to client — never leak internal DB details
                // SECURITY.md invariant 12: SQLSTATE class 22 (data exception) and
                // 23 (integrity constraint) are the CLIENT sending bad input, not a
                // server crash — map to 4xx, never 500. An injection probe like
                // `?id=eq.1' OR '1'='1` is a 22P02 invalid-text-representation for the
                // integer cast; returning 500 would flag every malformed value as a
                // possible crash.
                if code == "23505" {
                    // unique_violation
                    AppError::Conflict("duplicate value violates unique constraint".into())
                } else if code == "23503" {
                    // foreign_key_violation
                    AppError::Conflict("foreign key constraint violation".into())
                } else if code.starts_with("22") || code.starts_with("23") {
                    // data exception / integrity constraint — malformed client input
                    AppError::BadRequest("invalid request".into())
                } else if code == "42501" {
                    // insufficient_privilege (RLS)
                    AppError::Forbidden("insufficient privileges".into())
                } else if code.starts_with("42") {
                    // syntax/undefined errors
                    AppError::BadRequest("invalid request".into())
                } else {
                    AppError::Internal("internal database error".into())
                }
            }
            _ => {
                error!("database error: {}", e);
                AppError::Internal("internal database error".into())
            }
        }
    }
}
