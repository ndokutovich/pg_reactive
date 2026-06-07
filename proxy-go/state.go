package main

import (
	"strconv"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgxpool"
	"pgstack-proxy-go/middleware"
	"pgstack-proxy-go/realtime"
	"pgstack-proxy-go/rest"
	"pgstack-proxy-go/secrets"
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

	// RateLimiter for auth endpoints (/auth/v1/signup, /auth/v1/token,
	// /auth/v1/recover, /auth/v1/magiclink) — the brute-force / email-
	// bombing targets that incur real DB writes or outbound mail.
	RateLimiter *middleware.RateLimiter

	// AnonymousLimiter is a separate (typically more generous) bucket for
	// /auth/v1/anonymous because that endpoint only mints a stateless
	// JWT — no DB write, no email, no real cost — so the threat model
	// allows much higher request rates without bundling guest-token
	// dashboards into the same cap as signup brute-forcing.
	AnonymousLimiter *middleware.RateLimiter

	// WSSemaphore limits concurrent WebSocket connections.
	// Acquire: non-blocking send. Release: receive.
	WSSemaphore chan struct{}

	// Mailer sends transactional email (or logs in dev mode).
	Mailer *Mailer

	// Catalog caches pg_catalog table metadata for REST handlers.
	Catalog *rest.Catalog

	// WebhookManager manages webhook delivery from NOTIFY payloads.
	WebhookManager *realtime.WebhookManager

	// SecretBox decrypts every at-rest secret the proxy holds: edge
	// function env vars (env_vars_encrypted) AND webhook signing secrets
	// (webhooks.secret_encrypted). Nil when SECRETS_ENCRYPTION_KEY is
	// unset — CreateWebhook then refuses non-empty secrets, and Refresh
	// drops any encrypted-secret webhook from the in-memory cache.
	SecretBox *secrets.Box
}

// NewAppState constructs AppState from a loaded Config and pool. secretBox
// may be nil when SECRETS_ENCRYPTION_KEY is unset.
func NewAppState(cfg Config, pool *pgxpool.Pool, secretBox *secrets.Box) *AppState {
	s := &AppState{
		Config:         cfg,
		Pool:           pool,
		Hub:            realtime.NewHub(),
		RateLimiter:      middleware.NewRateLimiterWithProxies(cfg.AuthRateLimit, cfg.AuthRateWindow, cfg.TrustedProxies),
		AnonymousLimiter: middleware.NewRateLimiterWithProxies(cfg.AnonymousRateLimit, cfg.AnonymousRateWindow, cfg.TrustedProxies),
		WSSemaphore:    make(chan struct{}, cfg.MaxConnections),
		Mailer:         NewMailer(cfg),
		Catalog:        rest.NewCatalog(),
		WebhookManager: realtime.NewWebhookManager(pool, secretBox),
		SecretBox:      secretBox,
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
