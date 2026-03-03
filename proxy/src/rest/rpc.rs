use axum::extract::{OriginalUri, Path, State};
use axum::response::IntoResponse;
use axum::Json;
use sqlx::Row;

use crate::error::AppError;
use crate::middleware::rls::{rls_transaction, RequestClaims};
use crate::rest::query_builder::quote_ident;
use crate::state::AppState;

/// POST /rest/v1/rpc/{function} — Call a PostgreSQL function.
///
/// Body is a JSON object with named parameters:
/// `{ "arg1": "value1", "arg2": 42 }`
///
/// Returns the function result as JSON.
pub async fn call_rpc(
    State(state): State<AppState>,
    Path(fn_name): Path<String>,
    claims: RequestClaims,
    body: Option<Json<serde_json::Value>>,
) -> Result<impl IntoResponse, AppError> {
    // Validate function name
    if !is_valid_fn_name(&fn_name) {
        return Err(AppError::BadRequest(format!(
            "invalid function name: '{}'",
            fn_name
        )));
    }

    let Json(body) = body.unwrap_or(Json(serde_json::Value::Object(Default::default())));

    let obj = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("RPC body must be a JSON object".into()))?;

    // Look up function parameter types from pg_proc for proper casting.
    let fn_meta = lookup_function(&state.pg_pool, &fn_name).await?;

    let mut param_names: Vec<String> = Vec::new();
    let mut placeholders: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    for (i, (key, val)) in obj.iter().enumerate() {
        if !is_valid_fn_name(key) {
            return Err(AppError::BadRequest(format!(
                "invalid parameter name: '{}'",
                key
            )));
        }
        param_names.push(key.clone());
        params.push(json_to_param(val));
        // Find the parameter type from function metadata
        let pg_type = fn_meta
            .params
            .iter()
            .find(|p| p.name == *key)
            .map(|p| p.pg_type.as_str())
            .unwrap_or("text");
        // Use named parameter syntax with cast: param_name := $N::type
        placeholders.push(format!("{} := ${}::{}", quote_ident(key), i + 1, safe_pg_type(pg_type)));
    }

    // Use to_json() to always get JSON output regardless of return type.
    // For set-returning functions, json_agg wraps the rows.
    // For scalar functions, to_json wraps the value.
    let fn_call = format!("public.{}", quote_ident(&fn_name));

    // Strategy: wrap in a CTE that calls the function, then aggregate to JSON.
    // This handles both scalar and set-returning functions uniformly.
    let sql = format!(
        "WITH _rpc AS (SELECT * FROM {}({})) \
         SELECT COALESCE(json_agg(row_to_json(_rpc)), '[]'::json) AS data FROM _rpc",
        fn_call,
        placeholders.join(", ")
    );

    let mut tx = rls_transaction(&state.pg_pool, &claims).await?;

    let mut q = sqlx::query(&sql);
    for param in &params {
        q = q.bind(param);
    }

    let row = q.fetch_one(&mut *tx).await?;
    let result: serde_json::Value = row.get::<serde_json::Value, _>("data");

    tx.commit().await?;

    // Set-returning functions (RETURNS TABLE / RETURNS SETOF) -> always return array.
    // Scalar functions -> unwrap single-element array to bare value.
    if fn_meta.returns_set {
        Ok(Json(result))
    } else {
        match result {
            serde_json::Value::Array(ref arr) if arr.len() == 1 => {
                let item = &arr[0];
                // Scalar: unwrap {"fn_name": value} to just value
                if let serde_json::Value::Object(map) = item {
                    if map.len() == 1 {
                        let val = map.values().next().unwrap().clone();
                        return Ok(Json(val));
                    }
                }
                Ok(Json(item.clone()))
            }
            _ => Ok(Json(result)),
        }
    }
}

/// GET /rest/v1/rpc/{function} — Call a PostgreSQL function with query params.
pub async fn call_rpc_get(
    State(state): State<AppState>,
    Path(fn_name): Path<String>,
    claims: RequestClaims,
    uri: OriginalUri,
) -> Result<impl IntoResponse, AppError> {
    // Parse query params into a JSON object
    let mut obj = serde_json::Map::new();

    if let Some(query) = uri.0.query() {
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                let key = urlencoding::decode(key)
                    .map_err(|_| AppError::BadRequest("invalid URL encoding".into()))?;
                let value = urlencoding::decode(value)
                    .map_err(|_| AppError::BadRequest("invalid URL encoding".into()))?;
                obj.insert(
                    key.into_owned(),
                    serde_json::Value::String(value.into_owned()),
                );
            }
        }
    }

    let body = Json(serde_json::Value::Object(obj));

    call_rpc(
        State(state),
        Path(fn_name),
        claims,
        Some(body),
    )
    .await
}

fn json_to_param(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => val.to_string(),
    }
}

/// Validate a pg_type string before interpolation into SQL.
/// Only allows alphanumeric, underscore, space, brackets, parentheses, dots, commas.
/// Returns "text" as safe fallback for any invalid type.
fn safe_pg_type(pg_type: &str) -> &str {
    if pg_type
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " _[].(),".contains(c))
    {
        pg_type
    } else {
        "text"
    }
}

fn is_valid_fn_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.chars().next().unwrap().is_ascii_digit()
}

struct FunctionMeta {
    params: Vec<FnParam>,
    returns_set: bool,
}

struct FnParam {
    name: String,
    pg_type: String,
}

/// Look up function parameter names and types from pg_proc.
async fn lookup_function(
    pool: &sqlx::PgPool,
    fn_name: &str,
) -> Result<FunctionMeta, AppError> {
    // Query pg_proc for function parameter info
    let row = sqlx::query(
        "SELECT
            p.proargnames AS arg_names,
            p.proargtypes AS arg_type_oids,
            p.proretset AS returns_set
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = $1
           AND n.nspname = 'public'
         LIMIT 1"
    )
    .bind(fn_name)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(row) => {
            let arg_names: Option<Vec<String>> = row.get("arg_names");
            let arg_names = arg_names.unwrap_or_default();
            let returns_set: bool = row.get("returns_set");
            // proargtypes is oidvector — fetch as Vec<u32> via a secondary query
            // Simpler: just get type names via a joined query
            let type_rows = sqlx::query(
                "SELECT format_type(t.oid, NULL) AS type_name
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 CROSS JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY AS u(type_oid, ord)
                 JOIN pg_type t ON t.oid = u.type_oid
                 WHERE p.proname = $1 AND n.nspname = 'public'
                 ORDER BY u.ord"
            )
            .bind(fn_name)
            .fetch_all(pool)
            .await?;

            let arg_types: Vec<String> = type_rows
                .iter()
                .map(|r| r.get::<String, _>("type_name"))
                .collect();

            let params: Vec<FnParam> = arg_names
                .into_iter()
                .zip(arg_types.into_iter())
                .map(|(name, pg_type)| FnParam { name, pg_type })
                .collect();

            Ok(FunctionMeta { params, returns_set })
        }
        None => {
            // Function not found — return empty params, let PG produce the error
            Ok(FunctionMeta { params: Vec::new(), returns_set: false })
        }
    }
}
