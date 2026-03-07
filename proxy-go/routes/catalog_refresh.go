package routes

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
)

// CatalogRefresh returns an http.HandlerFunc for POST /api/catalog/refresh.
//
// Restricted to service_role only. Calls refreshFn to reload REST catalog
// table metadata from pg_catalog.
func CatalogRefresh(
	pool *pgxpool.Pool,
	cfg middleware.RLSConfig,
	refreshFn func(pool *pgxpool.Pool) error,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := middleware.ResolveClaims(r, cfg)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "catalog refresh requires service_role")
			return
		}

		if err := refreshFn(pool); err != nil {
			log.Error().Err(err).Msg("catalog refresh failed")
			writeJSONError(w, http.StatusInternalServerError, "catalog refresh failed")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}
