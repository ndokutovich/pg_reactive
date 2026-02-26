use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use crate::auth::keys::is_service_role;
use crate::state::AppState;

/// POST /api/demo — execute a predefined demo action.
/// Requires service_role key OR ENABLE_SQL_ENDPOINT=true.
pub async fn demo_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Require service_role key OR explicit ENABLE_SQL_ENDPOINT=true
    let has_service_role = state
        .config
        .service_role_key
        .as_deref()
        .map_or(false, |k| is_service_role(&headers, k));
    if !state.config.enable_sql_endpoint && !has_service_role {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "service_role key required for /api/demo (or set ENABLE_SQL_ENDPOINT=true)"})),
        );
    }

    let action = match payload.get("action").and_then(|v| v.as_str()) {
        Some(a) => a,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "missing action field"})),
            );
        }
    };

    let sql = match demo_action_sql(action) {
        Some(s) => s,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("unknown action: {}", action)})),
            );
        }
    };

    match sqlx::query(sql).execute(&state.pg_pool).await {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "action": action,
                "rows_affected": result.rows_affected(),
            })),
        ),
        Err(e) => {
            tracing::error!("demo action '{}' failed: {}", action, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "SQL execution failed"})),
            )
        }
    }
}

fn demo_action_sql(action: &str) -> Option<&'static str> {
    match action {
        "insert_product" => Some(
            "INSERT INTO products (name, price, category) \
             VALUES ('Demo ' || substr(md5(random()::text),1,4), \
             round((random()*200+20)::numeric,2), 'electronics')",
        ),
        "update_price" => Some(
            "UPDATE products SET price = round((random()*300+10)::numeric,2) \
             WHERE id = (SELECT id FROM products ORDER BY random() LIMIT 1)",
        ),
        "delete_demo_product" => Some(
            "DELETE FROM products WHERE name LIKE 'Demo %' \
             AND id = (SELECT id FROM products WHERE name LIKE 'Demo %' \
             ORDER BY id DESC LIMIT 1)",
        ),
        "insert_order" => Some(
            "INSERT INTO orders (customer_id, product_id, qty, total) \
             VALUES (\
               (SELECT id FROM customers ORDER BY random() LIMIT 1), \
               (SELECT id FROM products ORDER BY random() LIMIT 1), \
               floor(random()*5+1)::int, \
               round((random()*300+20)::numeric,2))",
        ),
        "insert_customer" => Some(
            "INSERT INTO customers (name, region) \
             VALUES ('Demo ' || substr(md5(random()::text),1,4), \
             (ARRAY['us-east','us-west','eu-west','ap-south'])[floor(random()*4+1)::int])",
        ),
        "delete_demo_customer" => Some(
            "DELETE FROM customers WHERE name LIKE 'Demo %' \
             AND id = (SELECT id FROM customers WHERE name LIKE 'Demo %' \
             ORDER BY id DESC LIMIT 1)",
        ),
        "reduce_stock" => Some(
            "UPDATE inventory SET stock_qty = GREATEST(stock_qty - floor(random()*15+1)::int, 0) \
             WHERE id = (SELECT id FROM inventory ORDER BY random() LIMIT 1)",
        ),
        "restock" => Some(
            "UPDATE inventory SET stock_qty = stock_qty + 50 \
             WHERE id = (SELECT id FROM inventory WHERE stock_qty <= reorder_point \
             ORDER BY stock_qty ASC LIMIT 1)",
        ),
        "insert_sensor_reading" => Some(
            "INSERT INTO sensor_readings (sensor_id, temperature, humidity) \
             VALUES ('sensor-' || chr(65 + (random()*3)::int), \
             round((20 + random()*10)::numeric,2), \
             round((30 + random()*40)::numeric,2))",
        ),
        "insert_sensor_burst" => Some(
            "INSERT INTO sensor_readings (sensor_id, temperature, humidity) \
             SELECT 'sensor-' || chr(65 + (i % 3)), \
             round((20 + random()*10)::numeric,2), \
             round((30 + random()*40)::numeric,2) \
             FROM generate_series(1, 10) AS s(i)",
        ),
        "update_sensor" => Some(
            "UPDATE sensor_readings SET temperature = round((15 + random()*20)::numeric,2) \
             WHERE id = (SELECT id FROM sensor_readings ORDER BY random() LIMIT 1)",
        ),
        _ => None,
    }
}
