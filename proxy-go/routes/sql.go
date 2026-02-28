package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
)

// SQLConfig carries the config fields needed by the SQL route.
type SQLConfig struct {
	EnableSQLEndpoint bool
	ServiceRoleKey    string
	// RLSConfig is embedded for claim resolution.
	RLS middleware.RLSConfig
	// CatalogRefreshFn is called after DDL statements to keep the REST
	// catalog in sync. May be nil (catalog refresh is skipped).
	CatalogRefreshFn func() error
}

// SQL returns an http.HandlerFunc for POST /api/sql.
//
// Requires service_role key OR EnableSQLEndpoint=true.
//
// SELECT/WITH statements are wrapped in a read-only transaction:
//
//	SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) AS data FROM (<sql>) t
//
// Other statements are executed directly and the rows_affected count is returned.
func SQL(pool *pgxpool.Pool, cfg SQLConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Auth: require service_role key OR explicit flag.
		hasServiceRole := isServiceRole(r, cfg.ServiceRoleKey)
		if !cfg.EnableSQLEndpoint && !hasServiceRole {
			writeJSONError(w, http.StatusUnauthorized,
				"service_role key required for /api/sql (or set ENABLE_SQL_ENDPOINT=true)")
			return
		}

		var payload struct {
			SQL string `json:"sql"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		sql := strings.TrimSpace(payload.SQL)
		if sql == "" {
			writeJSONError(w, http.StatusBadRequest, "missing or empty sql field")
			return
		}

		upper := strings.ToUpper(strings.TrimSpace(sql))
		isSelect := strings.HasPrefix(upper, "SELECT") || strings.HasPrefix(upper, "WITH")
		// pgr. functions (subscribe, unsubscribe) do DML internally via SPI.
		// They must not run inside a READ ONLY transaction.
		callsPGR := strings.Contains(upper, "PGR.")
		useReadOnly := isSelect && !callsPGR

		ctx := r.Context()

		if useReadOnly {
			trimmed := strings.TrimRight(sql, ";")
			wrapped := "SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) AS data FROM (" + trimmed + ") t"

			tx, err := pool.Begin(ctx)
			if err != nil {
				log.Error().Err(err).Msg("SQL: begin transaction")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}

			if _, err = tx.Exec(ctx, "SET TRANSACTION READ ONLY"); err != nil {
				_ = tx.Rollback(ctx)
				log.Error().Err(err).Msg("SQL: SET TRANSACTION READ ONLY")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}

			var raw json.RawMessage
			if err = tx.QueryRow(ctx, wrapped).Scan(&raw); err != nil {
				_ = tx.Rollback(ctx)
				log.Error().Err(err).Msg("SQL SELECT execution failed")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}

			if err = tx.Commit(ctx); err != nil {
				log.Error().Err(err).Msg("SQL: commit")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}

			writeJSONOK(w, map[string]any{"ok": true, "rows": raw})

		} else if isSelect {
			// SELECT calling pgr. functions — must run read-write (pgr funcs do DML internally).
			trimmed := strings.TrimRight(sql, ";")
			wrapped := "SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) AS data FROM (" + trimmed + ") t"
			var raw json.RawMessage
			if err := pool.QueryRow(ctx, wrapped).Scan(&raw); err != nil {
				log.Error().Err(err).Msg("SQL SELECT (pgr) execution failed")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}
			writeJSONOK(w, map[string]any{"ok": true, "rows": raw})
		} else {
			ct, err := pool.Exec(context.Background(), sql)
			if err != nil {
				log.Error().Err(err).Msg("SQL execution failed")
				writeJSONError(w, http.StatusInternalServerError, "SQL execution failed")
				return
			}

			// Auto-refresh REST catalog after DDL so new tables/columns
			// are immediately visible via /rest/v1/.
			isDDL := strings.HasPrefix(upper, "CREATE") ||
				strings.HasPrefix(upper, "ALTER") ||
				strings.HasPrefix(upper, "DROP")
			if isDDL && cfg.CatalogRefreshFn != nil {
				if err := cfg.CatalogRefreshFn(); err != nil {
					log.Warn().Err(err).Msg("auto catalog refresh after DDL failed")
				}
			}

			writeJSONOK(w, map[string]any{"ok": true, "rows_affected": ct.RowsAffected()})
		}
	}
}

// isServiceRole returns true when the Authorization: Bearer header matches the
// service role key (constant-time comparison).
func isServiceRole(r *http.Request, serviceRoleKey string) bool {
	if serviceRoleKey == "" {
		return false
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := auth[len("Bearer "):]
	return middleware.ConstantTimeEqExported(token, serviceRoleKey)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSONOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}
