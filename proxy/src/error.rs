use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

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
                // PG error codes
                let code = db_err.code().unwrap_or_default();
                if code == "23505" {
                    // unique_violation
                    AppError::Conflict(db_err.message().to_string())
                } else if code == "42501" {
                    // insufficient_privilege (RLS)
                    AppError::Forbidden("insufficient privileges".into())
                } else if code.starts_with("42") {
                    // syntax/access errors
                    AppError::BadRequest(db_err.message().to_string())
                } else {
                    AppError::Internal(format!("database error: {}", db_err.message()))
                }
            }
            _ => AppError::Internal(format!("database error: {}", e)),
        }
    }
}
