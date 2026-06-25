//! Edge Functions for the Rust proxy — feature-parity port of the Go reference
//! `proxy-go/functions/`.
//!
//! Routing (mounted in `main.rs`), status codes, the `verify_jwt` gate, the
//! `X-Pgstack-*` auth-header injection, and the runtime-dispatch table mirror Go
//! exactly. Runtimes:
//!
//! | runtime      | how it runs                                                   |
//! |--------------|---------------------------------------------------------------|
//! | `embedded`   | in-process JS via boa (`embedded.rs`); `db.query` over the pool|
//! | `plv8`       | `SELECT pgstack.fn_{name}(body)` in an RLS tx (`pl.rs`)        |
//! | `plpython3u` | same SQL calling convention as plv8 (`pl.rs`)                  |
//! | `deno`       | reverse-proxy to the global `EDGE_RUNTIME_URL` (`deno.rs`)     |
//! | `http`       | reverse-proxy to the function's own `upstream_url` (`http.rs`),|
//! |              | gated by the SSRF guard (`validate_upstream_url`)             |

mod catalog;
mod deno;
mod embedded;
mod http;
mod pl;
mod proxy;

use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use tracing::{error, warn};

pub use catalog::{spawn_auto_refresh, FunctionsCatalog};
pub use deno::deno_health;

use crate::middleware::rls::{resolve_claims, RequestClaims};
use crate::state::AppState;

/// JSON `{"error": msg}` body with the given status — the uniform error shape
/// for all edge-function responses (mirror Go `writeJSONError`).
fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// Validate an edge function name: a letter/underscore then up to 62
/// `[A-Za-z0-9_-]` (mirror Go `fnNameRe`).
fn is_valid_fn_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    if name.len() > 63 {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// GET/POST /functions/v1/{name} — resolve the function, gate on `verify_jwt`,
/// then dispatch to the runtime (mirror Go `invoke`).
pub async fn invoke(State(state): State<AppState>, Path(name): Path<String>, req: Request) -> Response {
    if !is_valid_fn_name(&name) {
        return json_error(StatusCode::BAD_REQUEST, "invalid function name");
    }

    let (parts, body) = req.into_parts();
    let headers = parts.headers;
    let method = parts.method;
    let query = parts.uri.query().map(|s| s.to_string());

    let claims = match resolve_claims(&headers, &state) {
        Ok(c) => c,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "authentication required"),
    };

    let fm = match state.functions.get(&name).await {
        Some(f) => f,
        None => {
            warn!(fn = %name, "functions: function not found");
            return json_error(StatusCode::NOT_FOUND, "function not found");
        }
    };

    // verify_jwt gate: an anon caller is refused when the function requires a JWT.
    if fm.verify_jwt && claims.role == "anon" {
        return json_error(StatusCode::UNAUTHORIZED, "JWT required for this function");
    }

    let body_bytes = match to_bytes(body, state.config.max_body_size).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "cannot read body"),
    };

    let timeout = Duration::from_millis(state.config.edge_fn_timeout_ms);

    match fm.runtime.as_str() {
        "embedded" => {
            if !state.config.embedded_functions {
                return json_error(StatusCode::BAD_REQUEST, "embedded runtime disabled");
            }
            let pool = state.pool_for(&claims.role).clone();
            let fut =
                embedded::execute_embedded(fm.code.clone(), body_bytes.to_vec(), claims.clone(), pool);
            let exec = if timeout.is_zero() {
                fut.await
            } else {
                match tokio::time::timeout(timeout, fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        return json_error(StatusCode::GATEWAY_TIMEOUT, "function execution timed out")
                    }
                }
            };
            match exec {
                Ok(out) => (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    out,
                )
                    .into_response(),
                Err(e) => {
                    error!(fn = %name, error = %e, "functions: embedded execution failed");
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "function execution failed")
                }
            }
        }

        "plv8" | "plpython3u" => {
            let fut = pl::invoke_pl_runtime(&state, &name, body_bytes, &claims, "pgstack");
            if timeout.is_zero() {
                fut.await
            } else {
                match tokio::time::timeout(timeout, fut).await {
                    Ok(r) => r,
                    Err(_) => json_error(StatusCode::GATEWAY_TIMEOUT, "function execution timed out"),
                }
            }
        }

        "deno" => {
            deno::proxy_to_deno(
                &state.config.edge_runtime_url,
                &name,
                method,
                &headers,
                query.as_deref(),
                body_bytes,
                &claims,
                timeout,
            )
            .await
        }

        "http" => {
            http::proxy_to_upstream(
                &fm,
                &name,
                method,
                &headers,
                query.as_deref(),
                body_bytes,
                &claims,
                timeout,
            )
            .await
        }

        other => {
            warn!(fn = %name, runtime = %other, "functions: unknown runtime");
            json_error(StatusCode::BAD_REQUEST, "unsupported function runtime")
        }
    }
}

/// GET /functions/v1/ — list registered functions (service_role only; mirror Go
/// `List`). Env vars are never serialised.
pub async fn list(State(state): State<AppState>, claims: RequestClaims) -> Response {
    if claims.role != "service_role" {
        return json_error(StatusCode::FORBIDDEN, "listing functions requires service_role");
    }
    let funcs: Vec<serde_json::Value> = state
        .functions
        .list()
        .await
        .into_iter()
        .map(|fm| {
            let mut obj = serde_json::json!({
                "name": fm.name,
                "runtime": fm.runtime,
                "verify_jwt": fm.verify_jwt,
                "status": fm.status,
            });
            if !fm.code.is_empty() {
                obj["code"] = serde_json::Value::String(fm.code.clone());
            }
            if !fm.upstream_url.is_empty() {
                obj["upstream_url"] = serde_json::Value::String(fm.upstream_url.clone());
            }
            obj
        })
        .collect();
    (StatusCode::OK, Json(funcs)).into_response()
}

/// POST /functions/v1/_refresh — reload the catalog (service_role only; mirror
/// Go `Refresh`). Reads `pgstack.edge_functions` on the admin pool.
pub async fn refresh(State(state): State<AppState>, claims: RequestClaims) -> Response {
    if claims.role != "service_role" {
        return json_error(StatusCode::FORBIDDEN, "functions refresh requires service_role");
    }
    match state.functions.refresh(&state.admin_pool).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => {
            error!(error = %e, "functions: catalog refresh failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "catalog refresh failed")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_valid_fn_name;

    #[test]
    fn fn_name_validation_matches_go_regex() {
        for ok in ["hello", "_x", "my-fn", "a1_b2-c3", "H"] {
            assert!(is_valid_fn_name(ok), "want valid: {ok}");
        }
        for bad in ["", "1abc", "-leading", "has space", "white space", &"x".repeat(64)] {
            assert!(!is_valid_fn_name(bad), "want invalid: {bad}");
        }
    }
}
