package main

import (
	"encoding/json"
	"net/http"

	"github.com/rs/zerolog/log"
)

// writeError writes a JSON error response: {"error":"<msg>"}.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

// writeJSON writes a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Error().Err(err).Msg("failed to encode JSON response")
	}
}

// pgErrCode extracts the PostgreSQL SQLSTATE code from a pgx error.
// Returns "" if not a PG database error.
func pgErrCode(err error) string {
	if err == nil {
		return ""
	}
	// pgx wraps pg errors as *pgconn.PgError which has a Code field.
	// Use interface assertion since pgconn is an indirect dependency.
	type pgError interface {
		SQLState() string
	}
	if e, ok := err.(pgError); ok {
		return e.SQLState()
	}
	return ""
}

// pgErrorStatus maps a PostgreSQL error to an HTTP status code and sanitized message.
// It never leaks internal database details to the client.
func pgErrorStatus(err error) (int, string) {
	code := pgErrCode(err)
	log.Error().Err(err).Str("pg_code", code).Msg("database error")

	switch code {
	case "23505":
		// unique_violation
		return http.StatusConflict, "duplicate value violates unique constraint"
	case "23503":
		// foreign_key_violation
		return http.StatusConflict, "foreign key constraint violation"
	case "23502":
		// not_null_violation
		return http.StatusBadRequest, "null value not allowed"
	case "23514":
		// check_violation
		return http.StatusBadRequest, "value violates check constraint"
	case "22P02":
		// invalid_text_representation
		return http.StatusBadRequest, "invalid input value"
	case "42501":
		// insufficient_privilege (RLS)
		return http.StatusForbidden, "insufficient privileges"
	default:
		if len(code) >= 2 && code[:2] == "42" {
			// syntax_error, undefined_table, undefined_column, etc.
			return http.StatusBadRequest, "invalid request"
		}
		return http.StatusInternalServerError, "internal database error"
	}
}

// writePGError writes an HTTP error response derived from a pgx database error.
func writePGError(w http.ResponseWriter, err error) {
	status, msg := pgErrorStatus(err)
	writeError(w, status, msg)
}
