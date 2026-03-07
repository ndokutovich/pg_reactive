package main

import (
	"strconv"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgxpool"
	"pgstack-proxy-go/middleware"
	"pgstack-proxy-go/realtime"
	"pgstack-proxy-go/rest"
)

// AppState is the shared application state injected into all HTTP handlers.
// Sub-packages receive only the specific fields they need to avoid circular imports.
type AppState struct {
	Config Config

	// PG connection pool for request handlers (REST, SQL, RLS transactions, etc.)
	Pool *pgxpool.Pool

	// PGConnected is true when the dedicated LISTEN connection is healthy.
	PGConnected atomic.Bool

	// Hub manages fan-out delivery from PG NOTIFY to WebSocket subscribers.
	// Each subscriber gets its own channel; Broadcast sends to all of them.
	Hub *realtime.Hub

	// RateLimiter for auth endpoints (/auth/v1/signup, /auth/v1/token).
	RateLimiter *middleware.RateLimiter

	// WSSemaphore limits concurrent WebSocket connections.
	// Acquire: non-blocking send. Release: receive.
	WSSemaphore chan struct{}

	// Mailer sends transactional email (or logs in dev mode).
	Mailer *Mailer

	// Catalog caches pg_catalog table metadata for REST handlers.
	Catalog *rest.Catalog
}

// NewAppState constructs AppState from a loaded Config and pool.
func NewAppState(cfg Config, pool *pgxpool.Pool) *AppState {
	s := &AppState{
		Config:      cfg,
		Pool:        pool,
		Hub:         realtime.NewHub(),
		RateLimiter: middleware.NewRateLimiter(cfg.AuthRateLimit, cfg.AuthRateWindow),
		WSSemaphore: make(chan struct{}, cfg.MaxConnections),
		Mailer:      NewMailer(cfg),
		Catalog:     rest.NewCatalog(),
	}
	return s
}

// Health returns a snapshot of key runtime indicators. Used by /health and
// operational dashboards.
func (s *AppState) Health() map[string]string {
	pg := "ok"
	if !s.PGConnected.Load() {
		pg = "disconnected"
	}
	active := s.Config.MaxConnections - len(s.WSSemaphore)
	return map[string]string{
		"db":             pg,
		"ws_active":      strconv.Itoa(active),
		"ws_max":         strconv.Itoa(s.Config.MaxConnections),
		"catalog_tables": strconv.Itoa(s.Catalog.TableCount()),
	}
}

// Close releases shared resources. Should be called on graceful shutdown
// after the HTTP server has stopped accepting new connections.
func (s *AppState) Close() {
	s.Pool.Close()
}
