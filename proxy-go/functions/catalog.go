// Package functions implements Edge Functions for pgstack-proxy-go.
//
// Supported runtimes:
//   - "deno"     — reverse-proxy to Supabase edge-runtime container
//   - "plv8"     — call PG function via existing RPC mechanism
//   - "embedded" — execute JS via goja VM (stub, not yet implemented)
//
// The FunctionsCatalog provides a thread-safe, in-memory cache of function
// metadata loaded from the pgstack.edge_functions table.
package functions

import (
	"context"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// FunctionMeta describes a single edge function's configuration.
type FunctionMeta struct {
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`    // "deno", "embedded", "plv8"
	VerifyJWT bool   `json:"verify_jwt"`
	Status    string `json:"status"`     // "active", "inactive"
	Code      string `json:"code,omitempty"` // for embedded/plv8 (empty for deno)
}

// FunctionsCatalog is a thread-safe, in-memory cache of edge function metadata.
// Call Refresh to (re)load from the database. Get and List are safe for
// concurrent read access at any time.
type FunctionsCatalog struct {
	mu    sync.RWMutex
	funcs map[string]*FunctionMeta
}

// NewFunctionsCatalog returns an empty, ready-to-use catalog.
func NewFunctionsCatalog() *FunctionsCatalog {
	return &FunctionsCatalog{funcs: make(map[string]*FunctionMeta)}
}

// Refresh loads (or reloads) active edge function metadata from the
// pgstack.edge_functions table. It is safe to call while handlers are running;
// the swap is atomic under the write lock.
func (c *FunctionsCatalog) Refresh(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("functions catalog refresh: acquire connection: %w", err)
	}
	defer conn.Release()

	const q = `
SELECT name, runtime, verify_jwt, status, COALESCE(code, '') AS code
FROM pgstack.edge_functions
WHERE status = 'active'`

	rows, err := conn.Query(ctx, q)
	if err != nil {
		return fmt.Errorf("functions catalog refresh: query: %w", err)
	}
	defer rows.Close()

	funcs := make(map[string]*FunctionMeta)
	for rows.Next() {
		var fm FunctionMeta
		if err := rows.Scan(&fm.Name, &fm.Runtime, &fm.VerifyJWT, &fm.Status, &fm.Code); err != nil {
			return fmt.Errorf("functions catalog refresh: scan: %w", err)
		}
		funcs[fm.Name] = &fm
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("functions catalog refresh: rows: %w", err)
	}

	c.mu.Lock()
	c.funcs = funcs
	c.mu.Unlock()

	log.Info().Int("count", len(funcs)).Msg("edge functions catalog refreshed")
	return nil
}

// Get returns the FunctionMeta for the named function, or nil if not found.
func (c *FunctionsCatalog) Get(name string) *FunctionMeta {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.funcs[name]
}

// List returns all active functions in the catalog.
func (c *FunctionsCatalog) List() []*FunctionMeta {
	c.mu.RLock()
	defer c.mu.RUnlock()

	out := make([]*FunctionMeta, 0, len(c.funcs))
	for _, fm := range c.funcs {
		out = append(out, fm)
	}
	return out
}
