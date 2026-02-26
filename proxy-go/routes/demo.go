package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Demo returns an http.HandlerFunc for POST /api/demo.
//
// Requires service_role key OR EnableSQLEndpoint=true. Executes one of the
// predefined demo actions against the demo tables (products, orders, customers,
// inventory, sensor_readings). Matches the Rust proxy action set exactly.
func Demo(pool *pgxpool.Pool, enableSQLEndpoint bool, serviceRoleKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hasServiceRole := isServiceRole(r, serviceRoleKey)
		if !enableSQLEndpoint && !hasServiceRole {
			writeJSONError(w, http.StatusUnauthorized,
				"service_role key required for /api/demo (or set ENABLE_SQL_ENDPOINT=true)")
			return
		}

		var payload struct {
			Action string `json:"action"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if payload.Action == "" {
			writeJSONError(w, http.StatusBadRequest, "missing action field")
			return
		}

		sql, ok := demoSQL(payload.Action)
		if !ok {
			writeJSONError(w, http.StatusBadRequest, "unknown action: "+payload.Action)
			return
		}

		ct, err := pool.Exec(r.Context(), sql)
		if err != nil {
			log.Error().Err(err).Str("action", payload.Action).Msg("demo action failed")
			writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
			return
		}

		writeJSONOK(w, map[string]any{
			"ok":            true,
			"action":        payload.Action,
			"rows_affected": ct.RowsAffected(),
		})
	}
}

// demoSQL maps action names to hardcoded SQL statements.
// Matches the Rust proxy demo_action_sql function exactly.
func demoSQL(action string) (string, bool) {
	sqls := map[string]string{
		"insert_product": strings.Join([]string{
			"INSERT INTO products (name, price, category)",
			"VALUES ('Demo ' || substr(md5(random()::text),1,4),",
			"round((random()*200+20)::numeric,2), 'electronics')",
		}, " "),

		"update_price": strings.Join([]string{
			"UPDATE products SET price = round((random()*300+10)::numeric,2)",
			"WHERE id = (SELECT id FROM products ORDER BY random() LIMIT 1)",
		}, " "),

		"delete_demo_product": strings.Join([]string{
			"DELETE FROM products WHERE name LIKE 'Demo %'",
			"AND id = (SELECT id FROM products WHERE name LIKE 'Demo %'",
			"ORDER BY id DESC LIMIT 1)",
		}, " "),

		"insert_order": strings.Join([]string{
			"INSERT INTO orders (customer_id, product_id, qty, total)",
			"VALUES (",
			"(SELECT id FROM customers ORDER BY random() LIMIT 1),",
			"(SELECT id FROM products ORDER BY random() LIMIT 1),",
			"floor(random()*5+1)::int,",
			"round((random()*300+20)::numeric,2))",
		}, " "),

		"insert_customer": strings.Join([]string{
			"INSERT INTO customers (name, region)",
			"VALUES ('Demo ' || substr(md5(random()::text),1,4),",
			"(ARRAY['us-east','us-west','eu-west','ap-south'])[floor(random()*4+1)::int])",
		}, " "),

		"delete_demo_customer": strings.Join([]string{
			"DELETE FROM customers WHERE name LIKE 'Demo %'",
			"AND id = (SELECT id FROM customers WHERE name LIKE 'Demo %'",
			"ORDER BY id DESC LIMIT 1)",
		}, " "),

		"reduce_stock": strings.Join([]string{
			"UPDATE inventory SET stock_qty = GREATEST(stock_qty - floor(random()*15+1)::int, 0)",
			"WHERE id = (SELECT id FROM inventory ORDER BY random() LIMIT 1)",
		}, " "),

		"restock": strings.Join([]string{
			"UPDATE inventory SET stock_qty = stock_qty + 50",
			"WHERE id = (SELECT id FROM inventory WHERE stock_qty <= reorder_point",
			"ORDER BY stock_qty ASC LIMIT 1)",
		}, " "),

		"insert_sensor_reading": strings.Join([]string{
			"INSERT INTO sensor_readings (sensor_id, temperature, humidity)",
			"VALUES ('sensor-' || chr(65 + (random()*3)::int),",
			"round((20 + random()*10)::numeric,2),",
			"round((30 + random()*40)::numeric,2))",
		}, " "),

		"insert_sensor_burst": strings.Join([]string{
			"INSERT INTO sensor_readings (sensor_id, temperature, humidity)",
			"SELECT 'sensor-' || chr(65 + (i % 3)),",
			"round((20 + random()*10)::numeric,2),",
			"round((30 + random()*40)::numeric,2)",
			"FROM generate_series(1, 10) AS s(i)",
		}, " "),

		"update_sensor": strings.Join([]string{
			"UPDATE sensor_readings SET temperature = round((15 + random()*20)::numeric,2)",
			"WHERE id = (SELECT id FROM sensor_readings ORDER BY random() LIMIT 1)",
		}, " "),
	}

	sql, ok := sqls[action]
	return sql, ok
}
