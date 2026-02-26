package routes

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"pgstack-proxy-go/middleware"
)

// RLSDebug returns an http.HandlerFunc for GET /rest/v1/rls-debug.
//
// Restricted to service_role only. Runs a PG query inside an RLS transaction
// to show what PG sees for the current role and JWT claims. Useful for
// debugging RLS policies without hitting real tables.
//
// Response:
//
//	{"pg_role":"...","jwt_claims":{...},"request_role":"...","request_sub":"..."}
func RLSDebug(pool *pgxpool.Pool, cfg middleware.RLSConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := middleware.ResolveClaims(r, cfg)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, err.Error())
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "rls-debug requires service_role")
			return
		}

		tx, err := middleware.RLSTransaction(r.Context(), pool, claims)
		if err != nil {
			log.Error().Err(err).Msg("rls-debug: RLSTransaction failed")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}
		defer tx.Rollback(r.Context())

		row := tx.QueryRow(r.Context(),
			"SELECT current_setting('role') AS pg_role,"+
				" current_setting('request.jwt.claims', true) AS jwt_claims",
		)

		var pgRole string
		var jwtClaimsRaw *string
		if err := row.Scan(&pgRole, &jwtClaimsRaw); err != nil {
			log.Error().Err(err).Msg("rls-debug: query failed")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("rls-debug: commit failed")
			writeJSONError(w, http.StatusInternalServerError, "internal database error")
			return
		}

		var parsedClaims json.RawMessage
		if jwtClaimsRaw != nil {
			parsedClaims = json.RawMessage(*jwtClaimsRaw)
		} else {
			parsedClaims = json.RawMessage("null")
		}

		// Validate it's actual JSON; fall back to null if not.
		var probe any
		if json.Unmarshal(parsedClaims, &probe) != nil {
			parsedClaims = json.RawMessage("null")
		}

		resp := map[string]any{
			"pg_role":      pgRole,
			"jwt_claims":   parsedClaims,
			"request_role": claims.Role,
			"request_sub":  claims.Sub,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}
