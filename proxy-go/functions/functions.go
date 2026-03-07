package functions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

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
	Pool          *pgxpool.Pool
	ResolveClaims func(r *http.Request) (*rest.RequestClaims, error)
	Catalog       *FunctionsCatalog
	DatabaseURL   string // passed to functions as PGSTACK_DB_URL env hint
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

	switch fm.Runtime {
	case "embedded":
		result, execErr := executeEmbedded(r.Context(), fm.Code, bodyBytes, claims, d.Pool)
		if execErr != nil {
			log.Error().Err(execErr).Str("fn", fnName).Msg("functions: embedded execution failed")
			writeJSONError(w, http.StatusInternalServerError, "function execution failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)

	case "plv8":
		invokePLRuntime(d, w, r.Context(), fnName, bodyBytes, claims, "pgstack")

	case "plpython3u":
		invokePLRuntime(d, w, r.Context(), fnName, bodyBytes, claims, "pgstack")

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

	tx, err := beginRLSTx(ctx, d.Pool, claims)
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
		if err := d.Catalog.Refresh(r.Context(), d.Pool); err != nil {
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
