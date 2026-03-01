package functions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/rest"
)

// fnNameRe validates an edge function name: starts with a letter or underscore,
// followed by up to 62 alphanumeric, underscore, or hyphen characters.
// Hyphens are allowed (unlike PG function names) because edge functions use
// filesystem-style naming conventions.
var fnNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`)

// FunctionsDeps is the dependency bundle passed to all handler constructors.
type FunctionsDeps struct {
	Pool           *pgxpool.Pool
	ResolveClaims  func(r *http.Request) (*rest.RequestClaims, error)
	EdgeRuntimeURL string // empty = deno backend disabled
	Catalog        *FunctionsCatalog
	DatabaseURL    string // passed to functions as env
}

// Invoke returns an http.HandlerFunc for POST /functions/v1/{name}.
//
// It looks up the function in the catalog, checks JWT requirements, and
// dispatches to the appropriate runtime backend (deno, plv8, or embedded).
func Invoke(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invoke(d, w, r)
	}
}

// InvokeGet returns an http.HandlerFunc for GET /functions/v1/{name}.
//
// Same logic as Invoke but accepts GET requests.
func InvokeGet(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		invoke(d, w, r)
	}
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
		writeJSONError(w, http.StatusNotFound, "function not found: "+fnName)
		return
	}

	claims, err := d.ResolveClaims(r)
	if err != nil {
		writeJSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	// If the function requires JWT verification and the caller is anonymous,
	// reject the request.
	if fm.VerifyJWT && claims.Role == "anon" {
		writeJSONError(w, http.StatusUnauthorized, "JWT required for function: "+fnName)
		return
	}

	switch fm.Runtime {
	case "deno":
		if d.EdgeRuntimeURL == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "deno runtime not configured")
			return
		}
		proxy := denoProxy(d, fnName, claims)
		proxy.ServeHTTP(w, r)

	case "plv8":
		invokePLv8(d, w, r, fnName, claims)

	case "embedded":
		bodyBytes, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			writeJSONError(w, http.StatusBadRequest, "cannot read body")
			return
		}
		result, execErr := executeEmbedded(r.Context(), fm.Code, bodyBytes, claims)
		if execErr != nil {
			writeJSONError(w, http.StatusNotImplemented, execErr.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)

	default:
		writeJSONError(w, http.StatusBadRequest, "unknown runtime: "+fm.Runtime)
	}
}

// denoProxy creates a reverse proxy handler that forwards the request to the
// Supabase edge-runtime container, injecting pgstack identity headers.
func denoProxy(d *FunctionsDeps, fnName string, claims *rest.RequestClaims) http.Handler {
	target, err := url.Parse(d.EdgeRuntimeURL)
	if err != nil {
		log.Error().Err(err).Str("url", d.EdgeRuntimeURL).Msg("functions: invalid edge runtime URL")
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSONError(w, http.StatusInternalServerError, "invalid edge runtime configuration")
		})
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = "/functions/v1/" + fnName
		req.Header.Set("x-pgstack-role", claims.Role)
		req.Header.Set("x-pgstack-claims", claims.ClaimsJSON)
		req.Header.Set("x-pgstack-sub", claims.Sub)
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: deno proxy error")
		writeJSONError(w, http.StatusBadGateway, "edge runtime unavailable")
	}

	return proxy
}

// invokePLv8 calls a PG function pgstack.fn_{name} via an RLS transaction,
// passing the request body as a JSONB argument.
func invokePLv8(d *FunctionsDeps, w http.ResponseWriter, r *http.Request, fnName string, claims *rest.RequestClaims) {
	ctx := r.Context()

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "cannot read body")
		return
	}

	// Default to empty JSON object if no body.
	if len(bodyBytes) == 0 {
		bodyBytes = []byte("{}")
	}

	// Validate that the body is valid JSON.
	if !json.Valid(bodyBytes) {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	// Call pgstack.fn_{name}(body jsonb) -- the naming convention for plv8 edge functions.
	pgFnName := "fn_" + fnName
	sql := fmt.Sprintf(
		`SELECT to_json(pgstack.%s($1::jsonb)) AS data`,
		rest.QuoteIdent(pgFnName),
	)

	tx, err := beginRLSTx(ctx, d.Pool, claims)
	if err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: begin RLS transaction")
		writeJSONError(w, http.StatusInternalServerError, "internal database error")
		return
	}
	defer tx.Rollback(ctx)

	var result json.RawMessage
	row := tx.QueryRow(ctx, sql, string(bodyBytes))
	if err := row.Scan(&result); err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("functions: plv8 execution failed")
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

// List returns an http.HandlerFunc for GET /functions/v1/ that lists all
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
// reloads the edge functions catalog from the database.
// Restricted to service_role only.
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

		if err := d.Catalog.Refresh(r.Context(), d.Pool); err != nil {
			log.Error().Err(err).Msg("functions: catalog refresh failed")
			writeJSONError(w, http.StatusInternalServerError, "catalog refresh failed: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

// ---------- helpers (package-local, mirrors rest package) ----------

// beginRLSTx opens a pgx transaction and applies RLS context:
//
//	SET LOCAL ROLE <whitelisted-role>
//	SET LOCAL request.jwt.claims = <claims-json>
//
// The caller is responsible for Commit or Rollback.
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

// validRoles is the whitelist for SET LOCAL ROLE to prevent SQL injection.
var validRoles = map[string]string{
	"anon":          "SET LOCAL ROLE anon",
	"authenticated": "SET LOCAL ROLE authenticated",
	"service_role":  "SET LOCAL ROLE service_role",
}

// writeJSONError writes a JSON {"error":"<msg>"} body with the given status.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

// pgHTTPStatus maps a pgx/pgconn error to an HTTP status code and sanitised
// message.
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
