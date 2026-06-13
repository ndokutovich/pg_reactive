package functions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/rest"
)

// fnNameRe validates an edge function name: starts with a letter or underscore,
// followed by up to 62 alphanumeric, underscore, or hyphen characters.
var fnNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`)

// FunctionsDeps is the dependency bundle passed to all handler constructors.
type FunctionsDeps struct {
	Pool *pgxpool.Pool
	// AdminPool runs service_role invocations: the data Pool's `authenticator`
	// role is not a member of service_role, so a service_role function must run
	// on the admin pool's `authenticator_admin` login role (gemini audit finding
	// 6). Nil falls back to Pool (legacy single-role).
	AdminPool      *pgxpool.Pool
	ResolveClaims  func(r *http.Request) (*rest.RequestClaims, error)
	Catalog        *FunctionsCatalog
	DatabaseURL    string // passed to functions as PGSTACK_DB_URL env hint
	EdgeRuntimeURL string // URL of Deno edge-runtime container (empty = disabled)
	// EdgeFnTimeout is the per-invocation deadline applied uniformly across
	// all runtimes (embedded goja interrupt, PL SPI execution, reverse-proxy
	// upstreams). Zero or negative means no proxy-imposed deadline (only the
	// HTTP server's own ReadTimeout/WriteTimeout still apply).
	EdgeFnTimeout time.Duration
}

// poolFor routes service_role invocations to the admin pool (whose login role
// can assume service_role) and everything else to the data pool. Falls back to
// the data pool when no admin pool is wired (legacy single-role).
func (d *FunctionsDeps) poolFor(role string) *pgxpool.Pool {
	if role == "service_role" && d.AdminPool != nil {
		return d.AdminPool
	}
	return d.Pool
}

// Invoke returns an http.HandlerFunc for POST /functions/v1/{name}.
func Invoke(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { invoke(d, w, r) }
}

// InvokeGet returns an http.HandlerFunc for GET /functions/v1/{name}.
func InvokeGet(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { invoke(d, w, r) }
}

// invoke is the shared execution path for both POST and GET function invocation.
func invoke(d *FunctionsDeps, w http.ResponseWriter, r *http.Request) {
	fnName := chi.URLParam(r, "name")
	if !fnNameRe.MatchString(fnName) {
		writeJSONError(w, http.StatusBadRequest, "invalid function name")
		return
	}

	fm := d.Catalog.Get(fnName)
	if fm == nil {
		log.Warn().Str("fn", fnName).Msg("functions: function not found")
		writeJSONError(w, http.StatusNotFound, "function not found")
		return
	}

	claims, err := d.ResolveClaims(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	if fm.VerifyJWT && claims.Role == "anon" {
		writeJSONError(w, http.StatusUnauthorized, "JWT required for this function")
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "cannot read body")
		return
	}

	// Apply the uniform edge-function deadline to all runtimes. The original
	// request context is preserved as parent so that client disconnects still
	// cancel the work; the timeout is just an upper bound. Runtimes that
	// reverse-proxy (deno/http) rely on the wrapped r.Context() to flow into
	// httputil.ReverseProxy; runtimes that execute in-process (embedded/plv8/
	// plpython) take ctx as an explicit argument.
	ctx := r.Context()
	if d.EdgeFnTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d.EdgeFnTimeout)
		defer cancel()
		r = r.WithContext(ctx)
	}

	switch fm.Runtime {
	case "embedded":
		result, execErr := executeEmbedded(ctx, fm.Code, bodyBytes, claims, d.poolFor(claims.Role))
		if execErr != nil {
			log.Error().Err(execErr).Str("fn", fnName).Msg("functions: embedded execution failed")
			writeJSONError(w, http.StatusInternalServerError, "function execution failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)

	case "plv8":
		invokePLRuntime(d, w, ctx, fnName, bodyBytes, claims, "pgstack")

	case "plpython3u":
		invokePLRuntime(d, w, ctx, fnName, bodyBytes, claims, "pgstack")

	case "deno":
		// Restore the request body that was consumed by io.ReadAll above,
		// so the reverse proxy can forward it to the Deno edge-runtime.
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		r.ContentLength = int64(len(bodyBytes))
		proxyToDeno(d, w, r, fnName, claims)

	case "http":
		// Polyglot runtime — reverse-proxy to the function's own per-function
		// upstream container (see http.go). Body restored as for "deno".
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		r.ContentLength = int64(len(bodyBytes))
		proxyToUpstream(w, r, fm, claims)

	default:
		log.Warn().Str("fn", fnName).Str("runtime", fm.Runtime).Msg("functions: unknown runtime")
		writeJSONError(w, http.StatusBadRequest, "unsupported function runtime")
	}
}

// invokePLRuntime calls a PostgreSQL-hosted function pgstack.fn_{name}(body jsonb)
// via an RLS transaction. This is the shared execution path for both plv8 and
// plpython3u runtimes since both expose the same calling convention from the
// Go side — the difference is only in how the SQL function body is written.
//
// PL/v8 example:
//
//	CREATE FUNCTION pgstack.fn_hello(body jsonb) RETURNS jsonb
//	LANGUAGE plv8 AS $$ return { message: "hello from JS" }; $$;
//
// PL/Python 3u example:
//
//	CREATE FUNCTION pgstack.fn_hello(body jsonb) RETURNS jsonb
//	LANGUAGE plpython3u AS $$
//	import json
//	return json.dumps({"message": "hello from Python"})
//	$$;
func invokePLRuntime(d *FunctionsDeps, w http.ResponseWriter, ctx context.Context, fnName string, bodyBytes []byte, claims *rest.RequestClaims, schema string) {
	if len(bodyBytes) == 0 {
		bodyBytes = []byte("{}")
	}
	if !json.Valid(bodyBytes) {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	pgFnName := "fn_" + fnName
	sql := fmt.Sprintf(
		`SELECT to_json(%s.%s($1::jsonb)) AS data`,
		rest.QuoteIdent(schema),
		rest.QuoteIdent(pgFnName),
	)

	tx, err := beginRLSTx(ctx, d.poolFor(claims.Role), claims)
	if err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: begin RLS transaction")
		writeJSONError(w, http.StatusInternalServerError, "internal database error")
		return
	}
	defer tx.Rollback(ctx)

	var result json.RawMessage
	if err := tx.QueryRow(ctx, sql, string(bodyBytes)).Scan(&result); err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: PL runtime execution failed")
		status, msg := pgHTTPStatus(err)
		writeJSONError(w, status, msg)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: commit")
		writeJSONError(w, http.StatusInternalServerError, "internal database error")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

// List returns an http.HandlerFunc for GET /functions/v1/ — lists all
// registered edge functions. Restricted to service_role only.
func List(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "listing functions requires service_role")
			return
		}
		funcs := d.Catalog.List()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(funcs)
	}
}

// Refresh returns an http.HandlerFunc for POST /functions/v1/_refresh that
// reloads the catalog from the database. Restricted to service_role only.
func Refresh(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if claims.Role != "service_role" {
			writeJSONError(w, http.StatusForbidden, "functions refresh requires service_role")
			return
		}
		// service_role-only, and the catalog reads pgstack.edge_functions which
		// the data pool's authenticator role cannot (finding 6 split) — refresh
		// on the admin pool, like the initial load and auto-refresh (finding 3).
		if err := d.Catalog.Refresh(r.Context(), d.poolFor(claims.Role)); err != nil {
			log.Error().Err(err).Msg("functions: catalog refresh failed")
			writeJSONError(w, http.StatusInternalServerError, "catalog refresh failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

// ---------- helpers ----------

func beginRLSTx(ctx context.Context, pool *pgxpool.Pool, claims *rest.RequestClaims) (pgx.Tx, error) {
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

var validRoles = map[string]string{
	"anon":          "SET LOCAL ROLE anon",
	"authenticated": "SET LOCAL ROLE authenticated",
	"service_role":  "SET LOCAL ROLE service_role",
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

func pgHTTPStatus(err error) (int, string) {
	type pgError interface{ SQLState() string }
	var pge pgError
	if errors.As(err, &pge) {
		code := pge.SQLState()
		switch {
		case code == "23505":
			return http.StatusConflict, "duplicate value violates unique constraint"
		case code == "42501":
			return http.StatusForbidden, "insufficient privileges"
		case len(code) >= 2 && code[:2] == "42":
			return http.StatusBadRequest, "invalid request"
		}
	}
	return http.StatusInternalServerError, "internal database error"
}
