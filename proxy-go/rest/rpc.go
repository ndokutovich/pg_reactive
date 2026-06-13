package rest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// fnNameRe validates a PostgreSQL function name: starts with letter or
// underscore, followed by up to 62 alphanumeric/underscore characters.
var fnNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)

// isAuthenticatedRequest reports whether the request carries any identity
// surface that could segment the response on a per-user basis. Used by
// RPC caching to decide between "public" and "private, Vary: Authorization"
// Cache-Control. We intentionally treat the mere presence of an Authorization
// header / apikey header / token query param as authenticated even if the
// proxy resolved the caller as anon — a CDN cache hit serving an RLS-scoped
// payload to a different user is worse than a cache miss.
func isAuthenticatedRequest(r *http.Request) bool {
	if r.Header.Get("Authorization") != "" {
		return true
	}
	if r.Header.Get("apikey") != "" {
		return true
	}
	if r.URL.Query().Get("token") != "" {
		return true
	}
	if c, _ := r.Cookie("token"); c != nil && c.Value != "" {
		return true
	}
	return false
}

// FunctionMeta describes a PostgreSQL function's parameter list and return type.
type FunctionMeta struct {
	Params     []FnParam
	ReturnsSet bool   // true for RETURNS TABLE / RETURNS SETOF
	Volatility string // 'i'=IMMUTABLE, 's'=STABLE, 'v'=VOLATILE
}

// FnParam is one named (or positional) parameter of a PG function.
type FnParam struct {
	Name   string
	PGType string
}

// RPCPost handles POST /rest/v1/rpc/{function}.
//
// The request body must be a JSON object whose keys match the PG function's
// parameter names.  Values are bound as typed parameters ($1::type syntax).
func RPCPost(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fnName := chi.URLParam(r, "function")
		if !fnNameRe.MatchString(fnName) {
			writeJSONError(w, http.StatusBadRequest, "invalid function name")
			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "cannot read body")
			return
		}

		var args map[string]any
		if len(bodyBytes) > 0 {
			if err := json.Unmarshal(bodyBytes, &args); err != nil {
				writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
				return
			}
		}
		if args == nil {
			args = make(map[string]any)
		}

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		execRPC(w, r, d, fnName, args, claims)
	}
}

// RPCGet handles GET /rest/v1/rpc/{function}.
//
// Parameters are read from URL query string; values are auto-coerced to
// numbers and booleans where possible, otherwise treated as strings.
func RPCGet(d *RestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fnName := chi.URLParam(r, "function")
		if !fnNameRe.MatchString(fnName) {
			writeJSONError(w, http.StatusBadRequest, "invalid function name")
			return
		}

		args := parseQueryParamsAsArgs(r.URL.RawQuery)

		claims, err := d.ResolveClaims(r)
		if err != nil {
			writeJSONError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		execRPC(w, r, d, fnName, args, claims)
	}
}

// execRPC is the shared execution path for both RPCPost and RPCGet.
func execRPC(w http.ResponseWriter, r *http.Request, d *RestDeps, fnName string, args map[string]any, claims *RequestClaims) {
	ctx := r.Context()

	meta, err := lookupFunction(ctx, d.Pool, fnName)
	if err != nil {
		log.Error().Err(err).Str("fn", fnName).Msg("rpc: function lookup failed")
		writeJSONError(w, http.StatusNotFound, "function not found: "+fnName)
		return
	}

	sql, params, err := buildRPCCall(fnName, meta, args)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	tx, err := beginRLSTx(ctx, d.poolFor(claims.Role), claims)
	if err != nil {
		log.Error().Err(err).Msg("rpc: begin RLS transaction")
		writeJSONError(w, http.StatusInternalServerError, "internal database error")
		return
	}
	defer tx.Rollback(ctx)

	var result json.RawMessage
	row := tx.QueryRow(ctx, sql, params...)
	if err := row.Scan(&result); err != nil {
		status, msg := pgHTTPStatus(err)
		writeJSONError(w, status, msg)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error().Err(err).Msg("rpc: commit")
		writeJSONError(w, http.StatusInternalServerError, "internal database error")
		return
	}

	// Cache-Control for STABLE / IMMUTABLE functions.
	//
	// Audit F5: any RPC executed under an authenticated identity could be
	// observed differently across users (RLS scopes rows by JWT claims,
	// service_role bypasses RLS, etc.). A shared cache that keys only on
	// the URL would then serve user A's response to user B. Treat any
	// request that carries a token / Authorization / apikey header as
	// per-user — Cache-Control: private, plus Vary: Authorization, apikey
	// so any well-behaved intermediary segments by credential. Anonymous
	// requests (no auth surface at all) keep the original public cache.
	if meta.Volatility == "i" || meta.Volatility == "s" {
		maxAge := 60
		if meta.Volatility == "i" {
			maxAge = 3600
		}
		if isAuthenticatedRequest(r) {
			w.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", maxAge))
			w.Header().Add("Vary", "Authorization")
			w.Header().Add("Vary", "apikey")
		} else {
			w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAge))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

// lookupFunction fetches FunctionMeta from pg_proc.
// Only looks in the 'public' schema.
func lookupFunction(ctx context.Context, pool *pgxpool.Pool, fnName string) (*FunctionMeta, error) {
	// WITH ORDINALITY + ORDER BY is mandatory — a plain JOIN against
	// pg_type reorders the rows arbitrarily, and buildRPCCall then
	// pairs parameter names with the WRONG type. For a function like
	// place_order(p_symbol text, p_side text, p_type text, p_price
	// numeric, p_qty numeric, p_parent bigint DEFAULT NULL) the unordered
	// join returned {int8,text,text,text,numeric,numeric}, the proxy
	// bound `p_symbol := 'BTC-USD'::int8`, and PG raised 42883 — which
	// the REST layer surfaced as 400 "invalid request" without leaving
	// a trace in the logs. Affects every function with non-homogeneous
	// types or default args.
	const q = `
SELECT
    p.proargnames,
    ARRAY(
        SELECT t.typname
        FROM unnest(p.proargtypes) WITH ORDINALITY AS u(type_oid, ord)
        JOIN pg_type t ON t.oid = u.type_oid
        ORDER BY u.ord
    ) AS arg_types,
    p.proretset,
    p.provolatile::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = $1
  AND n.nspname = 'public'
LIMIT 1`

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	row := conn.QueryRow(ctx, q, fnName)

	var argNames []string
	var argTypes []string
	var returnsSet bool
	var volatility string

	if err := row.Scan(&argNames, &argTypes, &returnsSet, &volatility); err != nil {
		return nil, fmt.Errorf("function %q not found: %w", fnName, err)
	}

	params := make([]FnParam, len(argTypes))
	for i, typ := range argTypes {
		name := ""
		if i < len(argNames) && argNames[i] != "" {
			name = argNames[i]
		}
		params[i] = FnParam{Name: name, PGType: SafePGType(typ)}
	}

	return &FunctionMeta{Params: params, ReturnsSet: returnsSet, Volatility: volatility}, nil
}

// buildRPCCall constructs the SQL and bound parameter slice for a PG RPC call.
//
// Set-returning functions are wrapped with json_agg; scalar functions use a
// bare SELECT … AS data.
func buildRPCCall(fnName string, meta *FunctionMeta, args map[string]any) (string, []any, error) {
	callParts := make([]string, 0, len(meta.Params))
	params := make([]any, 0, len(meta.Params))
	idx := 1

	for _, p := range meta.Params {
		val, ok := args[p.Name]
		if !ok {
			// Parameter not supplied — PG will use its default (if any).
			continue
		}
		if p.Name == "" {
			callParts = append(callParts, fmt.Sprintf("$%d::%s", idx, p.PGType))
		} else {
			callParts = append(callParts, fmt.Sprintf("%s := $%d::%s", QuoteIdent(p.Name), idx, p.PGType))
		}
		params = append(params, anyToString(val))
		idx++
	}

	callSQL := fmt.Sprintf("public.%s(%s)", QuoteIdent(fnName), strings.Join(callParts, ", "))

	var sql string
	if meta.ReturnsSet {
		sql = fmt.Sprintf(
			`WITH _rpc AS (SELECT * FROM %s) `+
				`SELECT COALESCE(json_agg(row_to_json(_rpc)), '[]'::json) AS data FROM _rpc`,
			callSQL,
		)
	} else {
		sql = fmt.Sprintf(`SELECT to_json(%s) AS data`, callSQL)
	}

	return sql, params, nil
}

// parseQueryParamsAsArgs converts URL query parameters to a map[string]any,
// auto-coercing values to bool, int64, float64, or string.
func parseQueryParamsAsArgs(rawQuery string) map[string]any {
	vals, _ := url.ParseQuery(rawQuery)
	out := make(map[string]any, len(vals))
	for k, v := range vals {
		if len(v) > 0 {
			out[k] = coerceQueryValue(v[0])
		}
	}
	return out
}

// coerceQueryValue parses a query-string scalar as bool/int64/float64/string.
func coerceQueryValue(s string) any {
	switch strings.ToLower(s) {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	return s
}

// anyToString converts a Go value to a string suitable for PG $N binding.
// Nil passes through as nil (pgx will bind it as NULL).
func anyToString(v any) any {
	if v == nil {
		return nil
	}
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		return t.String()
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}
