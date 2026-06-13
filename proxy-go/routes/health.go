package routes

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

// HealthState is the minimal state subset needed by the health handler.
type HealthState struct {
	PGConnected *atomic.Bool
}

// Health returns an http.HandlerFunc for GET /health.
//
// Reports BOTH connection planes: the LISTEN/data connection and the admin pool.
// A broken admin pool (e.g. it cannot assume service_role) used to leave /health
// at 200 while auth/catalog/storage silently failed (gemini audit R4-2) — it now
// degrades the endpoint so load balancers pull the instance.
//
// Response:
//
//	200 {"status":"ok","pg_connected":true,"admin_connected":true}
//	503 {"status":"degraded","pg_connected":false,"admin_connected":...}
func Health(pgConnected, adminConnected *atomic.Bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pg := pgConnected.Load()
		admin := adminConnected.Load()
		ok := pg && admin
		status := "ok"
		httpStatus := http.StatusOK
		if !ok {
			status = "degraded"
			httpStatus = http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":          status,
			"pg_connected":    pg,
			"admin_connected": admin,
		})
	}
}
