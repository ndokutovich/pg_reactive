// Package functions implements Edge Functions for pgstack-proxy-go.
//
// Supported runtimes:
//   - "embedded"   — synchronous JS via goja VM inside the Go proxy (no external deps)
//   - "plv8"       — JavaScript inside PostgreSQL (full ACID, SPI access)
//   - "plpython3u" — Python 3 inside PostgreSQL (full ACID, pip packages available)
//   - "deno"       — the single global Deno edge-runtime container, via reverse
//     proxy to EDGE_RUNTIME_URL
//   - "http"       — a per-function container in ANY language: the function's
//     own upstream_url is reverse-proxied to, with caller identity injected as
//     X-Pgstack-* headers (see http.go)
//
// The FunctionsCatalog provides a thread-safe, in-memory cache of function
// metadata loaded from the pgstack.edge_functions table. It auto-refreshes
// via pg_notify on the 'pgstack_fn_changed' channel whenever a function is
// deployed, updated, or deleted.
package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/secrets"
)

// FunctionMeta describes a single edge function's configuration.
type FunctionMeta struct {
	Name      string `json:"name"`
	Runtime   string `json:"runtime"` // "embedded", "plv8", "plpython3u", "deno", "http"
	VerifyJWT bool   `json:"verify_jwt"`
	Status    string `json:"status"` // "active", "inactive"
	Code      string `json:"code,omitempty"`
	// UpstreamURL is the per-function HTTP target for runtime="http". Empty
	// for every other runtime.
	UpstreamURL string `json:"upstream_url,omitempty"`
	// Env carries decrypted environment variables to pass to the runtime at
	// invocation time. Loaded from pgstack.edge_functions.env_vars_encrypted
	// (AES-256-GCM ciphertext) on Refresh; never serialised back. Nil/empty
	// when the function has no env vars or SECRETS_ENCRYPTION_KEY is unset.
	Env map[string]string `json:"-"`
}

// FunctionsCatalog is a thread-safe, in-memory cache of edge function metadata.
// Call Refresh to (re)load from the database. Get and List are safe for
// concurrent read access at any time.
type FunctionsCatalog struct {
	mu       sync.RWMutex
	funcs    map[string]*FunctionMeta
	secrets  *secrets.Box // optional; nil when SECRETS_ENCRYPTION_KEY is unset
}

// NewFunctionsCatalog returns an empty, ready-to-use catalog.
//
// secretBox is used to decrypt env_vars_encrypted from pgstack.edge_functions.
// Pass nil when SECRETS_ENCRYPTION_KEY is not configured — functions whose row
// has a non-NULL env_vars_encrypted will be loaded WITHOUT Env (with a WARN
// log), so misconfiguration is loud but not fatal.
func NewFunctionsCatalog(secretBox *secrets.Box) *FunctionsCatalog {
	return &FunctionsCatalog{
		funcs:   make(map[string]*FunctionMeta),
		secrets: secretBox,
	}
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
SELECT name, runtime, verify_jwt, status,
       COALESCE(code, '')         AS code,
       COALESCE(upstream_url, '') AS upstream_url,
       env_vars_encrypted
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
		var envEncrypted []byte
		if err := rows.Scan(&fm.Name, &fm.Runtime, &fm.VerifyJWT, &fm.Status, &fm.Code, &fm.UpstreamURL, &envEncrypted); err != nil {
			return fmt.Errorf("functions catalog refresh: scan: %w", err)
		}
		// Decrypt env vars when present. A nil secrets.Box (no key configured)
		// causes ErrNoKey on non-empty input — we surface this loudly so the
		// operator sees the misconfiguration but the function still loads
		// without its env (preferable to silently failing all invocations).
		if len(envEncrypted) > 0 {
			plain, derr := c.secrets.Decrypt(envEncrypted)
			if derr != nil {
				log.Warn().Err(derr).Str("fn", fm.Name).
					Msg("functions: env_vars_encrypted present but cannot be decrypted; function loaded without env")
			} else if len(plain) > 0 {
				if uerr := json.Unmarshal(plain, &fm.Env); uerr != nil {
					log.Warn().Err(uerr).Str("fn", fm.Name).
						Msg("functions: env_vars decrypted but not valid JSON object; ignored")
					fm.Env = nil
				}
			}
		}
		// An http-runtime function with an unsafe or missing upstream_url is
		// dropped from the catalog here — it becomes a clean 404 rather than
		// ever reaching request handling as a live SSRF vector.
		if fm.Runtime == "http" {
			if _, verr := validateUpstreamURL(fm.UpstreamURL); verr != nil {
				log.Warn().Err(verr).Str("fn", fm.Name).Str("upstream", fm.UpstreamURL).
					Msg("functions: dropping http function with invalid upstream_url")
				continue
			}
		}
		funcs[fm.Name] = &fm
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("functions catalog refresh: rows: %w", err)
	}

	c.mu.Lock()
	c.funcs = funcs
	c.mu.Unlock()

	// Keep the per-function reverse-proxy cache coherent with the catalog —
	// builds proxies for active http upstreams, drops everything else.
	rebuildHTTPProxies(funcs)

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
				// Actually wait 5s before retrying. A bare select-with-default
				// fell through immediately, so a persistently failing acquire
				// (e.g. a broken admin pool) spun a tight error loop logging
				// ~100 warnings/sec (gemini audit finding 2). NewTimer (not
				// time.After) so the timer is released when ctx wins the race.
				timer := time.NewTimer(5 * time.Second)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
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
