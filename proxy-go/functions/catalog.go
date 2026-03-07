// Package functions implements Edge Functions for pgstack-proxy-go.
//
// Supported runtimes:
//   - "embedded"   — synchronous JS via goja VM inside the Go proxy (no external deps)
//   - "plv8"       — JavaScript inside PostgreSQL (full ACID, SPI access)
//   - "plpython3u" — Python 3 inside PostgreSQL (full ACID, pip packages available)
//
// The FunctionsCatalog provides a thread-safe, in-memory cache of function
// metadata loaded from the pgstack.edge_functions table. It auto-refreshes
// via pg_notify on the 'pgstack_fn_changed' channel whenever a function is
// deployed, updated, or deleted.
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
	Runtime   string `json:"runtime"`    // "embedded", "plv8", "plpython3u"
	VerifyJWT bool   `json:"verify_jwt"`
	Status    string `json:"status"`     // "active", "inactive"
	Code      string `json:"code,omitempty"`
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

// StartAutoRefresh starts a background goroutine that listens on the
// 'pgstack_fn_changed' PostgreSQL NOTIFY channel and calls Refresh whenever
// a function is deployed, updated, or deleted. The goroutine exits when ctx
// is cancelled. Any LISTEN errors are logged and retried.
//
// onRefresh is called after each successful refresh (may be nil).
func (c *FunctionsCatalog) StartAutoRefresh(ctx context.Context, dbURL string, pool *pgxpool.Pool, onRefresh func()) {
	go func() {
		for {
			if err := c.listenLoop(ctx, dbURL, pool, onRefresh); err != nil {
				if ctx.Err() != nil {
					return // context cancelled — clean exit
				}
				log.Warn().Err(err).Msg("functions catalog LISTEN loop error — retrying in 5s")
				select {
				case <-ctx.Done():
					return
				default:
				}
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()
}

// listenLoop establishes a dedicated LISTEN connection and processes NOTIFY
// messages until ctx is cancelled or an error occurs.
func (c *FunctionsCatalog) listenLoop(ctx context.Context, dbURL string, pool *pgxpool.Pool, onRefresh func()) error {
	// Acquire a dedicated connection for LISTEN (cannot share pool connections
	// across goroutines for LISTEN/NOTIFY).
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("functions catalog listen: acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "LISTEN pgstack_fn_changed"); err != nil {
		return fmt.Errorf("functions catalog listen: LISTEN: %w", err)
	}
	log.Info().Msg("functions catalog: listening for pgstack_fn_changed notifications")

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil // clean exit
			}
			return fmt.Errorf("WaitForNotification: %w", err)
		}
		log.Info().
			Str("channel", notification.Channel).
			Str("payload", notification.Payload).
			Msg("functions catalog: received change notification — refreshing")

		if refreshErr := c.Refresh(ctx, pool); refreshErr != nil {
			log.Warn().Err(refreshErr).Msg("functions catalog: auto-refresh failed")
		} else if onRefresh != nil {
			onRefresh()
		}
	}
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

