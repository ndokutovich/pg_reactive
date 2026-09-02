// Package rest implements a PostgREST-compatible REST API for pgstack-proxy-go.
//
// Supported endpoints:
//   - GET    /rest/v1/{table}          — SELECT with filters, ordering, pagination, FK embeds
//   - POST   /rest/v1/{table}          — INSERT (single object or array)
//   - PATCH  /rest/v1/{table}          — UPDATE with filters
//   - DELETE /rest/v1/{table}          — DELETE with filters
//   - GET    /rest/v1/rpc/{function}   — PG function call (params from query string)
//   - POST   /rest/v1/rpc/{function}   — PG function call (params from JSON body)
//
// The package is dependency-injected: it receives a Pool, Catalog, and a
// ClaimsResolver so that it does not import the main package (no circular
// imports).
package rest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RequestClaims mirrors middleware.RequestClaims to avoid a circular import
// between the rest package and the middleware package.
type RequestClaims struct {
	Role       string
	Sub        string
	Email      string
	ClaimsJSON string
}

// RestDeps is the dependency bundle passed to all handler constructors.
type RestDeps struct {
	// Pool is the data plane: connects as `authenticator` (member of anon +
	// authenticated only) and SET LOCAL ROLEs per request.
	Pool *pgxpool.Pool
	// AdminPool is the admin plane: connects as `authenticator_admin` (member of
	// service_role). service_role-key requests are routed here so the data
	// plane's login role need not be a member of service_role — a data-plane
	// compromise then cannot escalate (gemini audit finding 6). Nil falls back to
	// Pool (legacy single-role).
	AdminPool     *pgxpool.Pool
	Catalog       *Catalog
	ResolveClaims func(r *http.Request) (*RequestClaims, error)
}

// poolFor returns the pool a request of the given role must run on. service_role
// requests use the admin pool (whose login role can assume service_role); every
// other role uses the data pool. Falls back to the data pool when no admin pool
// is wired (legacy single-role deployments).
func (d *RestDeps) poolFor(role string) *pgxpool.Pool {
	if role == "service_role" && d.AdminPool != nil {
		return d.AdminPool
	}
	return d.Pool
}

// validRoles is the whitelist for SET LOCAL ROLE to prevent SQL injection.
var validRoles = map[string]string{
	"anon":          "SET LOCAL ROLE anon",
	"anonymous":     "SET LOCAL ROLE anonymous", // guests (0.3.0) — INV-A tier between anon and authenticated
	"authenticated": "SET LOCAL ROLE authenticated",
	"service_role":  "SET LOCAL ROLE service_role",
}

// beginRLSTx opens a pgx transaction and applies RLS context:
//
//	SET LOCAL ROLE <whitelisted-role>
//	SET LOCAL request.jwt.claims = <claims-json>
//
// The caller is responsible for Commit or Rollback.
func beginRLSTx(ctx context.Context, pool *pgxpool.Pool, claims *RequestClaims) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}

	roleSQL, ok := validRoles[claims.Role]
	if !ok {
		roleSQL = "SET LOCAL ROLE anon"
	}
	if _, err = tx.Exec(ctx, roleSQL); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}

	if _, err = tx.Exec(ctx, "SELECT set_config('request.jwt.claims', $1, true)", claims.ClaimsJSON); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}

	return tx, nil
}

// writeJSONError writes a JSON {"error":"<msg>"} body with the given status.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

// writeJSON writes v as JSON with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// pgHTTPStatus maps a pgx/pgconn error to an HTTP status code and sanitised
// message. Matches the mapping in error.go in the main package.
func pgHTTPStatus(err error) (int, string) {
	type pgError interface{ SQLState() string }

	var code string
	var pge pgError
	if errors.As(err, &pge) {
		code = pge.SQLState()
	}

	switch {
	case code == "23505":
		return http.StatusConflict, "duplicate value violates unique constraint"
	case code == "42501":
		return http.StatusForbidden, "insufficient privileges"
	case len(code) >= 2 && code[:2] == "42":
		return http.StatusBadRequest, "invalid request"
	// Round-33 / audit F2: class 22 (data exception) is client-input
	// shape — invalid_text_representation for an int column,
	// numeric_value_out_of_range, bad datetime format, etc. Mapping
	// these to 500 made the sql_injection test (which passes
	// "1' OR '1'='1" as an int filter value) look like a server crash.
	// 400 is the right answer — the client sent garbage, the server
	// is fine.
	case len(code) >= 2 && code[:2] == "22":
		return http.StatusBadRequest, "invalid input value for column"
	// Class 23 (integrity constraint violation) other than 23505 above:
	// foreign-key / not-null / check — also caller's bad input shape.
	case len(code) >= 2 && code[:2] == "23":
		return http.StatusBadRequest, "integrity constraint violation"
	default:
		return http.StatusInternalServerError, "internal database error"
	}
}
