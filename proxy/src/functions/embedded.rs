//! runtime="embedded" — synchronous JavaScript via an in-process JS engine.
//!
//! The Go reference (`proxy-go/functions/goja.go`) embeds `goja`. There is no
//! goja for Rust; the closest build-safe analogue is **boa** (`boa_engine`), a
//! pure-Rust ECMAScript engine — chosen over `rquickjs` because rquickjs bundles
//! QuickJS C and needs a C toolchain (`cl.exe` on the repo's MSVC host), whereas
//! boa compiles with cargo alone. boa is MIT/Unlicense dual-licensed.
//!
//! Calling convention mirrors goja exactly. Function code defines a top-level
//! `handler`:
//!
//! ```js
//! function handler(request) {
//!     const body = request.body;   // parsed JSON (or null)
//!     const role = request.role;   // "anon" | "authenticated" | "service_role"
//!     const sub  = request.sub;    // JWT subject ("" if anon)
//!     const rows = db.query("SELECT * FROM todos WHERE done = $1", false);
//!     return { count: rows.length, rows };
//! }
//! ```
//!
//! `db.query(sql, ...params)` runs inside an RLS transaction under the caller's
//! role + claims (one transaction per call, exactly like goja). Because boa is
//! synchronous and sqlx is async, the whole evaluation runs on a `spawn_blocking`
//! thread and `db.query` drives the async query via the tokio runtime handle;
//! the per-thread DB context is carried in a thread-local so the native function
//! can be a plain fn pointer (no GC-traced captures).
//!
//! Parity note vs goja: boa cannot be wall-clock interrupted mid-eval, so the
//! per-invocation deadline is enforced by the caller as a tokio timeout on the
//! response plus boa runtime limits (loop iterations / recursion) that bound
//! runaway scripts. `db.query` wraps the statement in a CTE
//! (`WITH _q AS (<sql>) SELECT json_agg(...)`), so SELECTs and data-modifying
//! statements with RETURNING are supported; a bare DML without RETURNING is not.

use std::cell::RefCell;

use boa_engine::object::ObjectInitializer;
use boa_engine::property::Attribute;
use boa_engine::{js_string, Context, JsArgs, JsError, JsNativeError, JsValue, Source};
use sqlx::{PgPool, Row};

use crate::middleware::rls::{rls_transaction, RequestClaims};

/// Per-blocking-thread database context for `db.query`. Set before the JS
/// evaluation runs and cleared after, so the plain-fn-pointer native callback
/// can reach the pool + claims + runtime handle without GC-traced captures.
struct DbCtx {
    handle: tokio::runtime::Handle,
    pool: PgPool,
    claims: RequestClaims,
}

thread_local! {
    static DB_CTX: RefCell<Option<DbCtx>> = const { RefCell::new(None) };
}

/// Generous loop / recursion caps — bound infinite loops and deep recursion
/// (non-catchable engine errors) without tripping legitimate edge functions.
const LOOP_ITERATION_LIMIT: u64 = 50_000_000;
const RECURSION_LIMIT: usize = 400;

/// Execute an embedded JS edge function and return its JSON-serialised result.
/// Runs on a blocking thread (boa is synchronous, sqlx is async).
pub async fn execute_embedded(
    code: String,
    body: Vec<u8>,
    claims: RequestClaims,
    pool: PgPool,
) -> Result<Vec<u8>, String> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        DB_CTX.with(|c| {
            *c.borrow_mut() = Some(DbCtx {
                handle,
                pool,
                claims: claims.clone(),
            });
        });
        let result = run_sync(&code, &body, &claims);
        DB_CTX.with(|c| *c.borrow_mut() = None);
        result
    })
    .await
    .map_err(|e| format!("embedded: join error: {e}"))?
}

fn run_sync(code: &str, body: &[u8], claims: &RequestClaims) -> Result<Vec<u8>, String> {
    let mut ctx = Context::default();
    ctx.runtime_limits_mut()
        .set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
    ctx.runtime_limits_mut()
        .set_recursion_limit(RECURSION_LIMIT);

    // ── console.log / console.error ───────────────────────────────────────
    let console = ObjectInitializer::new(&mut ctx)
        .function(
            boa_engine::NativeFunction::from_fn_ptr(console_log),
            js_string!("log"),
            1,
        )
        .function(
            boa_engine::NativeFunction::from_fn_ptr(console_log),
            js_string!("error"),
            1,
        )
        .build();
    ctx.register_global_property(js_string!("console"), console, Attribute::all())
        .map_err(|e| format!("embedded: register console: {e}"))?;

    // ── db.query(sql, ...params) ──────────────────────────────────────────
    let db = ObjectInitializer::new(&mut ctx)
        .function(
            boa_engine::NativeFunction::from_fn_ptr(db_query),
            js_string!("query"),
            1,
        )
        .build();
    ctx.register_global_property(js_string!("db"), db, Attribute::all())
        .map_err(|e| format!("embedded: register db: {e}"))?;

    // ── request object ────────────────────────────────────────────────────
    let body_json: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(body).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(body).into_owned())
        })
    };
    let claims_json: serde_json::Value = serde_json::from_str(&claims.claims_json)
        .unwrap_or_else(|_| serde_json::Value::String(claims.claims_json.clone()));
    let request = serde_json::json!({
        "body": body_json,
        "role": claims.role,
        "sub": claims.sub.clone().unwrap_or_default(),
        "claims": claims_json,
    });
    let request_js = JsValue::from_json(&request, &mut ctx)
        .map_err(|e| format!("embedded: build request: {e}"))?;
    ctx.register_global_property(js_string!("request"), request_js.clone(), Attribute::all())
        .map_err(|e| format!("embedded: register request: {e}"))?;

    // ── evaluate the function code (defines `handler`) ────────────────────
    ctx.eval(Source::from_bytes(code))
        .map_err(|e| format!("embedded function syntax/runtime error: {e}"))?;

    // ── locate + call handler ─────────────────────────────────────────────
    let handler = ctx
        .global_object()
        .get(js_string!("handler"), &mut ctx)
        .map_err(|e| format!("embedded: lookup handler: {e}"))?;
    let callable = handler
        .as_callable()
        .ok_or_else(|| "embedded function must define a top-level 'handler' function".to_string())?
        .clone();

    let result = callable
        .call(&JsValue::undefined(), &[request_js], &mut ctx)
        .map_err(|e| format!("embedded handler threw: {e}"))?;

    // ── serialise result ──────────────────────────────────────────────────
    // to_json yields None for an `undefined` return — serialise that as `null`.
    let out = result
        .to_json(&mut ctx)
        .map_err(|e| format!("embedded: cannot serialize handler result: {e}"))?
        .unwrap_or(serde_json::Value::Null);
    serde_json::to_vec(&out).map_err(|e| format!("embedded: serialize result: {e}"))
}

/// console.log / console.error — log to the proxy at debug level (mirror goja,
/// which never returns logs to the client).
fn console_log(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> Result<JsValue, JsError> {
    let parts: Vec<String> = args
        .iter()
        .map(|a| {
            a.to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_default()
        })
        .collect();
    tracing::debug!(source = "embedded-fn", "{}", parts.join(" "));
    Ok(JsValue::undefined())
}

/// db.query(sql, ...params) → array of row objects. Runs in its own RLS
/// transaction under the caller's role + claims (mirror goja db.query).
fn db_query(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> Result<JsValue, JsError> {
    let sql_arg = args.get_or_undefined(0);
    if sql_arg.is_undefined() {
        return Err(JsNativeError::error()
            .with_message("db.query: sql argument required")
            .into());
    }
    let sql = sql_arg.to_string(ctx)?.to_std_string_escaped();

    let mut params: Vec<serde_json::Value> = Vec::new();
    if args.len() > 1 {
        for a in &args[1..] {
            // boa's to_json yields None for `undefined`; treat that as SQL NULL.
            let v = a
                .to_json(ctx)
                .map_err(|e| JsNativeError::error().with_message(format!("db.query: param: {e}")))?
                .unwrap_or(serde_json::Value::Null);
            params.push(v);
        }
    }

    // Pull the blocking-thread DB context out, then drive the async query to
    // completion on the tokio runtime (we are on a spawn_blocking thread, so
    // block_on is permitted and never starves a runtime worker).
    let captured = DB_CTX.with(|c| {
        c.borrow()
            .as_ref()
            .map(|d| (d.handle.clone(), d.pool.clone(), d.claims.clone()))
    });
    let (handle, pool, claims) = match captured {
        Some(t) => t,
        None => {
            return Err(JsNativeError::error()
                .with_message("db.query: no database context")
                .into())
        }
    };

    let rows = handle
        .block_on(run_query(&pool, &claims, &sql, params))
        .map_err(|msg| JsNativeError::error().with_message(msg))?;

    JsValue::from_json(&rows, ctx)
}

async fn run_query(
    pool: &PgPool,
    claims: &RequestClaims,
    sql: &str,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut tx = rls_transaction(pool, claims)
        .await
        .map_err(|e| format!("db.query: begin transaction: {e:?}"))?;

    // CTE wrap → uniform JSON output for SELECT and RETURNING-DML alike.
    let wrapped = format!(
        "WITH _q AS ( {sql} ) \
         SELECT COALESCE(json_agg(row_to_json(_q)), '[]'::json) AS data FROM _q"
    );

    let mut q = sqlx::query(&wrapped);
    for p in params {
        q = match p {
            serde_json::Value::Null => q.bind(Option::<String>::None),
            serde_json::Value::Bool(b) => q.bind(b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    q.bind(i)
                } else {
                    q.bind(n.as_f64().unwrap_or(0.0))
                }
            }
            serde_json::Value::String(s) => q.bind(s),
            // Objects / arrays bind as jsonb.
            other => q.bind(other),
        };
    }

    let row = q
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("db.query: {e}"))?;
    let data: serde_json::Value = row.get("data");
    tx.commit()
        .await
        .map_err(|e| format!("db.query: commit: {e}"))?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-logic check: a handler that uses no DB runs and returns its JSON.
    #[tokio::test]
    async fn embedded_runs_handler_without_db() {
        // No DB_CTX is required when the function never calls db.query. We still
        // pass a closed pool that is never touched.
        let claims = RequestClaims::anon();
        let code = r#"
            function handler(request) {
                console.log("hello", request.role);
                return { role: request.role, doubled: 21 * 2, body: request.body };
            }
        "#
        .to_string();
        // Lazy pool — connect is never attempted because db.query is never called.
        let pool = PgPool::connect_lazy("postgres://invalid@127.0.0.1:1/none").unwrap();
        let out = execute_embedded(code, b"{\"x\":1}".to_vec(), claims, pool)
            .await
            .expect("handler runs");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["role"], "anon");
        assert_eq!(v["doubled"], 42);
        assert_eq!(v["body"]["x"], 1);
    }

    #[tokio::test]
    async fn embedded_missing_handler_errors() {
        let claims = RequestClaims::anon();
        let code = "var notHandler = 1;".to_string();
        let pool = PgPool::connect_lazy("postgres://invalid@127.0.0.1:1/none").unwrap();
        let err = execute_embedded(code, Vec::new(), claims, pool)
            .await
            .unwrap_err();
        assert!(err.contains("handler"), "got: {err}");
    }
}
