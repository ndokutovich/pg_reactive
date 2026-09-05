package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dop251/goja"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/rest"
)

// gojaValidRoles is the whitelist for SET LOCAL ROLE to prevent SQL injection
// inside the goja VM's db.query() calls.
var gojaValidRoles = map[string]string{
	"anon":          "SET LOCAL ROLE anon",
	"anonymous":     "SET LOCAL ROLE anonymous", // guests (0.3.0) — round 47 M6: a guest otherwise silently demoted to anon
	"authenticated": "SET LOCAL ROLE authenticated",
	"service_role":  "SET LOCAL ROLE service_role",
}

// executeEmbedded runs a JavaScript function using the goja VM.
//
// Function code must define a top-level `handler` function:
//
//	function handler(request) {
//	    const body  = request.body;   // parsed JSON (object or null)
//	    const role  = request.role;   // "anon" | "authenticated" | "service_role"
//	    const sub   = request.sub;    // JWT subject (empty string if anon)
//	    const rows  = db.query("SELECT * FROM todos WHERE done = $1", false);
//	    return { count: rows.length, rows };
//	}
//
// A new goja VM is created per invocation — VMs are not goroutine-safe and
// compilation overhead is acceptable for edge function workloads.
func executeEmbedded(ctx context.Context, code string, body []byte, claims *rest.RequestClaims, pool *pgxpool.Pool) ([]byte, error) {
	vm := goja.New()

	// ── console ───────────────────────────────────────────────────────────
	consoleObj := vm.NewObject()
	_ = consoleObj.Set("log", func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, arg := range call.Arguments {
			parts = append(parts, arg.String())
		}
		log.Debug().Str("source", "embedded-fn").Msg(strings.Join(parts, " "))
		return goja.Undefined()
	})
	_ = consoleObj.Set("error", func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, arg := range call.Arguments {
			parts = append(parts, arg.String())
		}
		log.Error().Str("source", "embedded-fn").Msg(strings.Join(parts, " "))
		return goja.Undefined()
	})
	if err := vm.Set("console", consoleObj); err != nil {
		return nil, fmt.Errorf("embedded: vm setup: %w", err)
	}

	// ── db.query(sql, ...params) → []object ───────────────────────────────
	// Executes a parameterized SQL query inside an RLS transaction using the
	// caller's claims. Each call opens its own transaction so that SET LOCAL
	// ROLE applies only to that query.
	if pool != nil {
		dbObj := vm.NewObject()
		_ = dbObj.Set("query", func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) == 0 {
				panic(vm.ToValue("db.query: sql argument required"))
			}
			sql := call.Arguments[0].String()
			params := make([]any, 0, len(call.Arguments)-1)
			for _, arg := range call.Arguments[1:] {
				params = append(params, arg.Export())
			}

			tx, err := pool.Begin(ctx)
			if err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: begin transaction: %v", err)))
			}
			defer tx.Rollback(ctx) //nolint:errcheck // best-effort cleanup

			// Apply RLS context: set role + JWT claims.
			roleSQL, ok := gojaValidRoles[claims.Role]
			if !ok {
				roleSQL = "SET LOCAL ROLE anon"
			}
			if _, err = tx.Exec(ctx, roleSQL); err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: set role: %v", err)))
			}
			if _, err = tx.Exec(ctx, "SELECT set_config('request.jwt.claims', $1, true)", claims.ClaimsJSON); err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: set claims: %v", err)))
			}

			rows, err := tx.Query(ctx, sql, params...)
			if err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: %v", err)))
			}
			defer rows.Close()

			fieldDescs := rows.FieldDescriptions()
			var result []map[string]any
			for rows.Next() {
				vals, err := rows.Values()
				if err != nil {
					panic(vm.ToValue(fmt.Sprintf("db.query: scan row: %v", err)))
				}
				row := make(map[string]any, len(fieldDescs))
				for i, fd := range fieldDescs {
					row[string(fd.Name)] = vals[i]
				}
				result = append(result, row)
			}
			if err := rows.Err(); err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: rows error: %v", err)))
			}

			if err := tx.Commit(ctx); err != nil {
				panic(vm.ToValue(fmt.Sprintf("db.query: commit: %v", err)))
			}

			if result == nil {
				result = []map[string]any{}
			}
			return vm.ToValue(result)
		})
		if err := vm.Set("db", dbObj); err != nil {
			return nil, fmt.Errorf("embedded: vm setup db: %w", err)
		}
	}

	// ── request object ────────────────────────────────────────────────────
	var bodyVal any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &bodyVal); err != nil {
			bodyVal = string(body) // fall back to raw string on parse error
		}
	}

	reqObj := vm.NewObject()
	_ = reqObj.Set("body", vm.ToValue(bodyVal))
	_ = reqObj.Set("role", claims.Role)
	_ = reqObj.Set("sub", claims.Sub)

	var claimsVal any
	if json.Unmarshal([]byte(claims.ClaimsJSON), &claimsVal) != nil {
		claimsVal = claims.ClaimsJSON
	}
	_ = reqObj.Set("claims", vm.ToValue(claimsVal))

	if err := vm.Set("request", reqObj); err != nil {
		return nil, fmt.Errorf("embedded: vm setup: %w", err)
	}

	// ── execution timeout via context cancellation ──────────────────────
	// The request context carries the HTTP server's WriteTimeout. A
	// background goroutine watches the context and interrupts the VM when
	// the deadline is exceeded or the request is cancelled.
	go func() {
		<-ctx.Done()
		vm.Interrupt("execution timeout")
	}()

	// ── execute function code ─────────────────────────────────────────────
	if _, err := vm.RunString(code); err != nil {
		if jsErr, ok := err.(*goja.Exception); ok {
			return nil, fmt.Errorf("embedded function syntax/runtime error: %s", jsErr.String())
		}
		return nil, fmt.Errorf("embedded function error: %w", err)
	}

	// ── locate and call handler ───────────────────────────────────────────
	handlerVal := vm.Get("handler")
	if handlerVal == nil || goja.IsUndefined(handlerVal) || goja.IsNull(handlerVal) {
		return nil, fmt.Errorf("embedded function must define a top-level 'handler' function")
	}
	handler, ok := goja.AssertFunction(handlerVal)
	if !ok {
		return nil, fmt.Errorf("embedded: 'handler' must be a function, got %T", handlerVal.Export())
	}

	result, err := handler(goja.Undefined(), vm.ToValue(reqObj))
	if err != nil {
		if jsErr, ok := err.(*goja.Exception); ok {
			return nil, fmt.Errorf("embedded handler threw: %s", jsErr.String())
		}
		return nil, fmt.Errorf("embedded handler error: %w", err)
	}

	// ── serialize result ──────────────────────────────────────────────────
	out, err := json.Marshal(result.Export())
	if err != nil {
		return nil, fmt.Errorf("embedded: cannot serialize handler result: %w", err)
	}
	return out, nil
}
