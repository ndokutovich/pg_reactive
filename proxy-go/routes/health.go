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
// Response:
//
//	200 {"status":"ok","pg_connected":true}
//	503 {"status":"degraded","pg_connected":false}
func Health(pgConnected *atomic.Bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ok := pgConnected.Load()
		status := "ok"
		httpStatus := http.StatusOK
		if !ok {
			status = "degraded"
			httpStatus = http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":       status,
			"pg_connected": ok,
		})
	}
}
