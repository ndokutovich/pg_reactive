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

	// PG connection pool for the RLS-bound data plane: REST/RPC/storage handlers
	// that SET LOCAL ROLE anon|authenticated|service_role per request. The proxy
	// connects as the powerless `authenticator` role, so a request that fails to
	// scope its role gets permission-denied, never a superuser bypass.
	Pool *pgxpool.Pool

	// AdminPool is the trusted backend pool: every connection runs SET ROLE
	// service_role (via AfterConnect). Used by operations that need server
	// privileges and do NOT SET ROLE themselves — auth handlers, catalog
	// introspection, the SQL endpoint, edge-function catalog, and the realtime
	// gate. This replaces those paths' former reliance on a superuser connection
	// (gemini audit P2). service_role is non-superuser: no COPY ... FROM PROGRAM,
	// no DROP DATABASE, no pg_authid.
	AdminPool *pgxpool.Pool

	// PGConnected is true when the dedicated LISTEN connection is healthy.
	PGConnected atomic.Bool

	// AdminConnected is true when the admin pool can serve a query (it can
	// assume service_role). A background prober updates it; /health degrades
	// when it is false so a broken admin plane isn't reported healthy (R4-2).
	AdminConnected atomic.Bool

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

// NewAppState constructs AppState from a loaded Config and the two pools.
// pool is the RLS-bound data plane (authenticator); adminPool is the trusted
// backend (service_role). WebhookManager reads pgstack.webhooks with no
// per-request SET ROLE, so it must run on the admin pool — the data-plane
// authenticator role is NOINHERIT and holds no privileges by default.
// secretBox may be nil when SECRETS_ENCRYPTION_KEY is unset.
func NewAppState(cfg Config, pool, adminPool *pgxpool.Pool, secretBox *secrets.Box) *AppState {
	s := &AppState{
		Config:         cfg,
		Pool:           pool,
		AdminPool:      adminPool,
		Hub:            realtime.NewHub(),
		RateLimiter:      middleware.NewRateLimiterWithProxies(cfg.AuthRateLimit, cfg.AuthRateWindow, cfg.TrustedProxies),
		AnonymousLimiter: middleware.NewRateLimiterWithProxies(cfg.AnonymousRateLimit, cfg.AnonymousRateWindow, cfg.TrustedProxies),
		WSSemaphore:    make(chan struct{}, cfg.MaxConnections),
		Mailer:         NewMailer(cfg),
		Catalog:        rest.NewCatalog(),
		WebhookManager: realtime.NewWebhookManager(adminPool, secretBox),
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
