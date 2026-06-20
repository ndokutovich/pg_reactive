package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"pgstack-proxy-go/secrets"
)

// Config holds all proxy configuration loaded from environment variables.
type Config struct {
	// Core
	DatabaseURL string
	// AdminDatabaseURL is the DSN for the trusted ADMIN pool. When set it should
	// point at the `authenticator_admin` login role (member of service_role); the
	// data pool's `authenticator` role is NOT a member of service_role, so a
	// data-plane compromise cannot escalate (gemini audit finding 6). Empty falls
	// back to DatabaseURL (legacy single-role model).
	AdminDatabaseURL string
	ListenAddr       string

	// PgstackEnv flips the strict-production validator. When equal to
	// "production", any of the following becomes a fatal startup error
	// instead of a warning: empty JWT_SECRET, dev-only-* secrets,
	// ENABLE_SQL_ENDPOINT=true, ALLOW_PERMISSIVE_CORS=true,
	// REQUIRE_AUTHENTICATED_WS=false combined with anon key.
	PgstackEnv string

	// Auth
	JWTSecret      string
	AnonKey        string
	ServiceRoleKey string

	// Connection limits
	MaxConnections int

	// OAuth providers
	GoogleClientID     string
	GoogleClientSecret string
	GitHubClientID     string
	GitHubClientSecret string
	SiteURL            string

	// Apple OAuth
	AppleClientID   string
	AppleTeamID     string
	AppleKeyID      string
	ApplePrivateKey string

	// Microsoft OAuth
	MicrosoftClientID     string
	MicrosoftClientSecret string

	// Generic OIDC
	OIDCClientID     string
	OIDCClientSecret string
	OIDCIssuerURL    string

	// Rate limiting
	AuthRateLimit       int
	AuthRateWindow      time.Duration
	// AnonymousRateLimit gates /auth/v1/anonymous separately. Default is
	// 10× AuthRateLimit because the endpoint mints a stateless throw-away
	// JWT (~50μs CPU, zero DB writes) — bundling it in the same bucket as
	// signup/token caps public guest-token demos at one tab per 2 seconds.
	AnonymousRateLimit  int
	AnonymousRateWindow time.Duration

	// Token expiry
	AccessTokenExpirySecs  int
	RefreshTokenExpiryDays int

	// Anonymous signin — gate-controlled mint of short-lived role=anon JWTs
	// so public-read demos can satisfy REQUIRE_AUTHENTICATED_WS=true without
	// embedding the raw anon-key as a fake "credential". Fail-closed: the
	// endpoint returns 503 until AllowAnonymousSignin is explicitly true.
	AllowAnonymousSignin bool
	AnonymousJWTTTLSecs  int

	// WebSocket
	BroadcastCapacity int
	// WSMaxPerIP caps concurrent WebSocket connections per source IP. 0
	// disables the cap (passthrough middleware). Default 10.
	WSMaxPerIP int

	// HTTP
	MaxBodySize        int64
	MaxFileSize        int64 // storage upload limit (default 50 MB)
	MaxBatchOperations int   // max operations per batch request (default 20)

	// HTTP server timeouts
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration

	// Compression
	GzipLevel int // 0=disabled, 1-9=level (default 5)

	// PG pool
	PGPoolMaxConns        int32
	PGPoolMinConns        int32
	PGPoolMaxConnIdleTime time.Duration

	// PG listener reconnect
	PGReconnectMaxBackoff time.Duration

	// Feature flags
	EnableSQLEndpoint   bool
	EnableDemoEndpoint  bool // mount POST /api/demo (mutates demo tables; off by default)
	PublicDemoSite      bool // explicit opt-in: this deployment IS the public pg_reactive demo, so the prod validator tolerates ENABLE_DEMO_ENDPOINT=true
	EmbeddedFunctions   bool // enable goja embedded JS functions (always true in embedded runtime)
	AllowPermissiveCORS    bool // when AllowedOrigins is empty, reflect any Origin (DEV ONLY)
	RequireAuthenticatedWS bool // when true, anon-key WS subscriptions are rejected (JWT required)

	// SecretsEncryptionKey is the raw 32-byte AES-256 key used to encrypt
	// every at-rest credential the proxy holds: edge function env vars
	// (pgstack.edge_functions.env_vars_encrypted) AND webhook signing
	// secrets (pgstack.webhooks.secret_encrypted). Nil/empty when
	// SECRETS_ENCRYPTION_KEY env is unset. Sourced via secrets.DecodeKey
	// from the base64 env value.
	SecretsEncryptionKey []byte

	// CORS
	AllowedOrigins []string

	// Trusted reverse proxies (for X-Forwarded-For and X-Forwarded-Proto)
	TrustedProxies []string

	// HSTS controls (audit round-21 F4+F5).
	//   HSTSMaxAgeSeconds: default 63072000 (2y); meets hstspreload submission
	//     minimum. Lower temporarily during initial rollout to limit blast
	//     radius if TLS breaks.
	//   HSTSPreload: false by default. Setting true adds "; preload" to the
	//     header — hstspreload.org submission is a ONE-WAY ticket. Opt in
	//     only when you intend to submit and never revert to HTTP.
	HSTSMaxAgeSeconds int
	HSTSPreload       bool

	// SMTP / email
	// EmailEnabled gates the email-based auth flows (verification, password
	// reset, magic link). Default true. When true in production, SMTP is
	// required (so those flows actually deliver). Set EMAIL_ENABLED=false for a
	// deployment that doesn't use email at all (e.g. OAuth-only) — production
	// then boots without SMTP and the email routes return 503 instead of
	// silently dropping a token-bearing message. This removes the footgun where
	// an operator disables PGSTACK_ENV=production just to escape the SMTP check.
	EmailEnabled             bool
	SMTPFrom                 string
	RequireEmailVerification bool
	SMTPHost                 string
	SMTPPort                 int
	SMTPUser                 string
	SMTPPass                 string
	AllowInsecureSMTP        bool

	// Studio SPA
	StudioDir string

	// Docs site (Docusaurus)
	DocsDir string

	// User static files (public/ directory)
	PublicDir string
	// PublicAllowInlineScripts adds 'unsafe-inline' to the PublicSPA CSP
	// script-src. Default false (strict). Needed for static apps that rely
	// on inline <script> blocks — e.g. the pg_reactive examples.
	PublicAllowInlineScripts bool

	// Storage
	StorageBackend string // "database" (default) or "disk"
	StorageDir     string // filesystem path when StorageBackend="disk"

	// Edge Functions
	// EdgeRuntimeURL is the single global Deno edge-runtime container used by
	// runtime="deno" functions; empty = disabled. The newer runtime="http"
	// carries a per-function upstream_url instead and needs no global config.
	EdgeRuntimeURL string
	// EdgeFnTimeout is the per-invocation deadline applied to every edge
	// function runtime (embedded goja, plv8, plpython, deno reverse-proxy,
	// per-function http upstream). Configurable via EDGE_FN_TIMEOUT_MS env
	// var; default 60s preserves the previous hardcoded http-runtime
	// behavior while giving downstream a single knob to tighten or loosen.
	EdgeFnTimeout time.Duration

	// TLS
	TLSMode      string // "off" | "auto" | "manual"
	TLSDomains   []string
	TLSCertDir   string
	TLSCertFile  string
	TLSKeyFile   string
	TLSACMEEmail string
	HTTPSAddr    string // listen address for HTTPS (default :443)
	HTTPAddr     string // plaintext address for ACME challenges (default :80)
}

// FromEnv loads configuration from environment variables, applying defaults.
func FromEnv() Config {
	cfg := Config{}

	cfg.DatabaseURL = envOrDefault("DATABASE_URL", "postgres://postgres:postgres@db:5432/app")
	// Empty => admin pool falls back to DatabaseURL (single-role). Set to the
	// authenticator_admin DSN for the finding-6 data/admin login-role split.
	cfg.AdminDatabaseURL = envOrDefault("ADMIN_DATABASE_URL", "")
	cfg.ListenAddr = envOrDefault("LISTEN_ADDR", "0.0.0.0:8080")
	// PGSTACK_ENV defaults to "production" (fail-secure): an operator who forgets
	// to set it gets the strict validator (rejects dev-only secrets, refuses
	// ENABLE_SQL_ENDPOINT, requires REQUIRE_AUTHENTICATED_WS, etc.) rather than
	// silently booting an insecure dev posture in production (gemini audit P3).
	// Dev/CI must opt into the relaxed posture explicitly with PGSTACK_ENV=
	// development — the dev compose files do this.
	cfg.PgstackEnv = strings.ToLower(os.Getenv("PGSTACK_ENV"))
	if cfg.PgstackEnv == "" {
		cfg.PgstackEnv = "production"
	}

	cfg.JWTSecret = os.Getenv("JWT_SECRET")

	cfg.AnonKey = os.Getenv("ANON_KEY")
	cfg.ServiceRoleKey = os.Getenv("SERVICE_ROLE_KEY")

	cfg.MaxConnections = envIntOrDefault("MAX_CONNECTIONS", 10000)

	cfg.GoogleClientID = os.Getenv("GOOGLE_CLIENT_ID")
	cfg.GoogleClientSecret = os.Getenv("GOOGLE_CLIENT_SECRET")
	cfg.GitHubClientID = os.Getenv("GITHUB_CLIENT_ID")
	cfg.GitHubClientSecret = os.Getenv("GITHUB_CLIENT_SECRET")
	cfg.SiteURL = os.Getenv("SITE_URL")

	cfg.AppleClientID = os.Getenv("APPLE_CLIENT_ID")
	cfg.AppleTeamID = os.Getenv("APPLE_TEAM_ID")
	cfg.AppleKeyID = os.Getenv("APPLE_KEY_ID")
	cfg.ApplePrivateKey = os.Getenv("APPLE_PRIVATE_KEY")

	cfg.MicrosoftClientID = os.Getenv("MICROSOFT_CLIENT_ID")
	cfg.MicrosoftClientSecret = os.Getenv("MICROSOFT_CLIENT_SECRET")

	cfg.OIDCClientID = os.Getenv("OIDC_CLIENT_ID")
	cfg.OIDCClientSecret = os.Getenv("OIDC_CLIENT_SECRET")
	cfg.OIDCIssuerURL = os.Getenv("OIDC_ISSUER_URL")

	cfg.AuthRateLimit = envIntOrDefault("AUTH_RATE_LIMIT", 30)
	cfg.AuthRateWindow = time.Duration(envIntOrDefault("AUTH_RATE_WINDOW", 60)) * time.Second
	cfg.AnonymousRateLimit = envIntOrDefault("ANONYMOUS_RATE_LIMIT", cfg.AuthRateLimit*10)
	cfg.AnonymousRateWindow = time.Duration(envIntOrDefault("ANONYMOUS_RATE_WINDOW", 60)) * time.Second

	cfg.AccessTokenExpirySecs = envIntOrDefault("ACCESS_TOKEN_EXPIRY_SECS", 3600)
	cfg.RefreshTokenExpiryDays = envIntOrDefault("REFRESH_TOKEN_EXPIRY_DAYS", 30)
	cfg.AllowAnonymousSignin = envBoolOrDefault("ALLOW_ANONYMOUS_SIGNIN", false)
	cfg.AnonymousJWTTTLSecs = envIntOrDefault("ANONYMOUS_JWT_TTL", 3600)

	cfg.BroadcastCapacity = envIntOrDefault("BROADCAST_CAPACITY", 1024)
	cfg.WSMaxPerIP = envIntOrDefault("WS_MAX_PER_IP", 10)

	cfg.MaxBodySize = int64(envIntOrDefault("MAX_BODY_SIZE", 1024*1024))
	cfg.MaxFileSize = int64(envIntOrDefault("MAX_FILE_SIZE", 52428800)) // 50 MB default for storage uploads
	cfg.MaxBatchOperations = envIntOrDefault("MAX_BATCH_OPERATIONS", 20)

	cfg.ReadTimeout = time.Duration(envIntOrDefault("READ_TIMEOUT", 30)) * time.Second
	cfg.WriteTimeout = time.Duration(envIntOrDefault("WRITE_TIMEOUT", 60)) * time.Second
	cfg.IdleTimeout = time.Duration(envIntOrDefault("IDLE_TIMEOUT", 120)) * time.Second
	cfg.ShutdownTimeout = time.Duration(envIntOrDefault("SHUTDOWN_TIMEOUT", 15)) * time.Second

	cfg.GzipLevel = envIntOrDefault("GZIP_LEVEL", 5)

	cfg.PGPoolMaxConns = int32(envIntOrDefault("PG_POOL_MAX_CONNS", 50))
	cfg.PGPoolMinConns = int32(envIntOrDefault("PG_POOL_MIN_CONNS", 5))
	cfg.PGPoolMaxConnIdleTime = time.Duration(envIntOrDefault("PG_POOL_MAX_CONN_IDLE_TIME", 300)) * time.Second

	pgBackoff := envIntOrDefault("PG_RECONNECT_MAX_BACKOFF", 30)
	cfg.PGReconnectMaxBackoff = time.Duration(pgBackoff) * time.Second

	cfg.EnableSQLEndpoint = envBoolOrDefault("ENABLE_SQL_ENDPOINT", false)
	cfg.EnableDemoEndpoint = envBoolOrDefault("ENABLE_DEMO_ENDPOINT", false)
	cfg.PublicDemoSite     = envBoolOrDefault("PUBLIC_DEMO_SITE", false)
	cfg.EmbeddedFunctions = envBoolOrDefault("EMBEDDED_FUNCTIONS", true)
	cfg.AllowPermissiveCORS = envBoolOrDefault("ALLOW_PERMISSIVE_CORS", false)
	cfg.RequireAuthenticatedWS = envBoolOrDefault("REQUIRE_AUTHENTICATED_WS", false)

	if rawKey := os.Getenv("SECRETS_ENCRYPTION_KEY"); rawKey != "" {
		key, err := secrets.DecodeKey(rawKey)
		if err != nil {
			// Misconfigured key is fatal — silently dropping it would mean
			// at-rest secrets degrade to "unencrypted" without anyone noticing.
			fmt.Fprintf(os.Stderr, "FATAL: SECRETS_ENCRYPTION_KEY invalid: %v\n", err)
			os.Exit(1)
		}
		cfg.SecretsEncryptionKey = key
	}

	rawOrigins := os.Getenv("ALLOWED_ORIGINS")
	if rawOrigins != "" {
		for _, o := range strings.Split(rawOrigins, ",") {
			if trimmed := strings.TrimSpace(o); trimmed != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, trimmed)
			}
		}
	}

	rawProxies := os.Getenv("TRUSTED_PROXIES")
	if rawProxies != "" {
		for _, p := range strings.Split(rawProxies, ",") {
			if trimmed := strings.TrimSpace(p); trimmed != "" {
				cfg.TrustedProxies = append(cfg.TrustedProxies, trimmed)
			}
		}
	}

	// HSTS knobs (audit round-21). Default max-age = 63072000 (2y); preload
	// off by default because hstspreload.org submission is irreversible.
	cfg.HSTSMaxAgeSeconds = envIntOrDefault("HSTS_MAX_AGE_SECONDS", 63072000)
	cfg.HSTSPreload = envBoolOrDefault("HSTS_PRELOAD", false)

	cfg.SMTPFrom = envOrDefault("SMTP_FROM", "noreply@pgstack.local")
	cfg.EmailEnabled = envBoolOrDefault("EMAIL_ENABLED", true)
	cfg.RequireEmailVerification = envBoolOrDefault("REQUIRE_EMAIL_VERIFICATION", false)
	cfg.SMTPHost = os.Getenv("SMTP_HOST")
	cfg.SMTPPort = envIntOrDefault("SMTP_PORT", 587)
	cfg.SMTPUser = os.Getenv("SMTP_USER")
	cfg.SMTPPass = os.Getenv("SMTP_PASS")
	// Opt-out for plaintext SMTP. By default the mailer refuses to send AUTH
	// credentials and reset/magic-link tokens over an un-upgraded connection
	// (any port) under PGSTACK_ENV=production. Set true only for a trusted
	// private-network relay in dev.
	cfg.AllowInsecureSMTP = envBoolOrDefault("ALLOW_INSECURE_SMTP", false)

	cfg.StudioDir = envOrDefault("STUDIO_DIR", "/studio")
	cfg.DocsDir = envOrDefault("DOCS_DIR", "/docs")
	cfg.PublicDir = os.Getenv("PUBLIC_DIR")
	cfg.PublicAllowInlineScripts = envBoolOrDefault("PUBLIC_ALLOW_INLINE_SCRIPTS", false)

	cfg.StorageBackend = envOrDefault("STORAGE_BACKEND", "database")
	cfg.StorageDir = envOrDefault("STORAGE_DIR", "/data/storage")

	cfg.EdgeRuntimeURL = os.Getenv("EDGE_RUNTIME_URL") // empty = disabled
	cfg.EdgeFnTimeout = time.Duration(envIntOrDefault("EDGE_FN_TIMEOUT_MS", 60000)) * time.Millisecond

	cfg.TLSMode = envOrDefault("TLS_MODE", "off")
	rawDomains := os.Getenv("TLS_DOMAINS")
	if rawDomains != "" {
		for _, d := range strings.Split(rawDomains, ",") {
			if trimmed := strings.TrimSpace(d); trimmed != "" {
				cfg.TLSDomains = append(cfg.TLSDomains, trimmed)
			}
		}
	}
	cfg.TLSCertDir = envOrDefault("TLS_CERT_DIR", "/data/certs")
	cfg.TLSCertFile = os.Getenv("TLS_CERT_FILE")
	cfg.TLSKeyFile = os.Getenv("TLS_KEY_FILE")
	cfg.TLSACMEEmail = os.Getenv("TLS_ACME_EMAIL")
	cfg.HTTPSAddr = envOrDefault("HTTPS_ADDR", ":443")
	cfg.HTTPAddr = envOrDefault("HTTP_ADDR", ":80")

	return cfg
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBoolOrDefault(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	if v == "true" || v == "1" {
		return true
	}
	if v == "false" || v == "0" {
		return false
	}
	// Unrecognised value — warn so misconfiguration is visible, use default.
	fmt.Fprintf(os.Stderr, "WARNING: %s=%q is not a valid boolean (use true/false/1/0) — using default %v\n", key, v, def)
	return def
}

// isPlaceholderSecret reports whether s is a publicly-known placeholder value —
// the repo ships these in .env.example / dev configs, so any of them reaching a
// production secret means an attacker already knows it. Compose's `${VAR:?}` only
// checks non-empty; `change-me-service-role-key` is non-empty yet public.
func isPlaceholderSecret(s string) bool {
	l := strings.ToLower(s)
	for _, bad := range []string{"dev-only", "change-me", "changeme", "placeholder", "replace-me", "your-secret", "example-secret"} {
		if strings.Contains(l, bad) {
			return true
		}
	}
	return false
}

// Validate checks the loaded configuration and returns human-readable errors.
// Callers should log all errors and abort startup if any are returned.
func (c Config) Validate() []string {
	var errs []string
	if c.JWTSecret != "" && len(c.JWTSecret) < 32 {
		errs = append(errs, fmt.Sprintf(
			"JWT_SECRET must be at least 32 characters (got %d); use a cryptographically random string",
			len(c.JWTSecret),
		))
	}
	if c.JWTSecret != "" && strings.Contains(c.JWTSecret, "dev-only") {
		fmt.Fprintf(os.Stderr, "WARNING: JWT_SECRET contains 'dev-only' — set a proper secret for production\n")
	}

	// Strict-production validator. Promote warnings to fatal when the
	// operator explicitly tagged this boot as production. Closes the
	// "deploy ran with publicly known dev secrets" footgun.
	if c.PgstackEnv == "production" {
		if c.JWTSecret == "" {
			errs = append(errs, "PGSTACK_ENV=production: JWT_SECRET is required (random 32+ bytes)")
		}
		if isPlaceholderSecret(c.JWTSecret) {
			errs = append(errs, "PGSTACK_ENV=production: JWT_SECRET is a publicly-known placeholder (dev-only / change-me / …) shipped in .env.example — generate a real key with `openssl rand -base64 32`")
		}
		// ANON_KEY: required non-empty in production. Even when the proxy
		// rejects anon-key WS subscriptions (REQUIRE_AUTHENTICATED_WS), a
		// REST request without an apikey would fall into the public-anon
		// path, so a non-empty value is still a meaningful gate.
		if c.AnonKey == "" {
			errs = append(errs, "PGSTACK_ENV=production: ANON_KEY is required (random 32+ bytes)")
		} else if isPlaceholderSecret(c.AnonKey) || c.AnonKey == "anon-key-12345" {
			errs = append(errs, "PGSTACK_ENV=production: ANON_KEY is a publicly-known placeholder/dev value — generate a real key with `openssl rand -base64 32`")
		} else if len(c.AnonKey) < 32 {
			errs = append(errs, fmt.Sprintf("PGSTACK_ENV=production: ANON_KEY is too short (%d chars, need 32+) — generate with `openssl rand -base64 32`", len(c.AnonKey)))
		}
		if c.ServiceRoleKey == "" {
			errs = append(errs, "PGSTACK_ENV=production: SERVICE_ROLE_KEY is required (random 32+ bytes)")
		} else if isPlaceholderSecret(c.ServiceRoleKey) {
			errs = append(errs, "PGSTACK_ENV=production: SERVICE_ROLE_KEY is a publicly-known placeholder/dev value — generate a real key with `openssl rand -base64 32`")
		} else if len(c.ServiceRoleKey) < 32 {
			errs = append(errs, fmt.Sprintf("PGSTACK_ENV=production: SERVICE_ROLE_KEY is too short (%d chars, need 32+) — generate with `openssl rand -base64 32`", len(c.ServiceRoleKey)))
		}
		if c.EnableSQLEndpoint {
			errs = append(errs, "PGSTACK_ENV=production: ENABLE_SQL_ENDPOINT=true is unsafe — raw SQL execution must not be reachable from the network")
		}
		if c.EnableDemoEndpoint && !c.PublicDemoSite {
			errs = append(errs, "PGSTACK_ENV=production: ENABLE_DEMO_ENDPOINT=true exposes a public demo-table mutator — disable it (or set PUBLIC_DEMO_SITE=true if this IS the public pg_reactive demo deployment)")
		}
		if c.AllowPermissiveCORS {
			errs = append(errs, "PGSTACK_ENV=production: ALLOW_PERMISSIVE_CORS=true reflects any Origin with credentials — set ALLOWED_ORIGINS instead")
		}
		if !c.RequireAuthenticatedWS && c.JWTSecret != "" && c.AnonKey != "" {
			errs = append(errs, "PGSTACK_ENV=production: REQUIRE_AUTHENTICATED_WS=false lets anon-key holders open any live-query WS — set REQUIRE_AUTHENTICATED_WS=true")
		}
		if len(c.SecretsEncryptionKey) == 0 {
			errs = append(errs, "PGSTACK_ENV=production: SECRETS_ENCRYPTION_KEY is required (at-rest encryption for edge function env vars AND webhook signing secrets)")
		}
		// The admin pool MUST use its own login role (authenticator_admin, member
		// of service_role), separate from the data pool. Without ADMIN_DATABASE_URL
		// the admin pool falls back to the data DSN — which, once the data role is
		// split off from service_role (finding 6), can no longer assume
		// service_role, leaving auth/catalog/storage broken while /health still
		// reports ok. The runtime startup check (main.go) additionally verifies
		// the data role cannot reach service_role and the admin pool can.
		if c.AdminDatabaseURL == "" {
			errs = append(errs, "PGSTACK_ENV=production: ADMIN_DATABASE_URL is required — point it at the authenticator_admin login role so the admin plane is a separate credential from the data plane (gemini audit findings 6 & R4-2)")
		}
		// Email-based auth flows (verification, password reset, magic link) need
		// a real delivery channel. When EMAIL_ENABLED (default true), SMTP is
		// required in production — otherwise those flows would silently drop a
		// token-bearing message and the operator would think reset "works". A
		// deployment that genuinely uses no email sets EMAIL_ENABLED=false and
		// boots without SMTP; its email routes then return 503 (no silent drop).
		// This removes the footgun where an operator disables PGSTACK_ENV=
		// production just to get past the SMTP check (and so also loses the
		// dev-secret / SQL-endpoint / CORS / WS guards). (round 26 F5 closed the
		// token-logging leak separately — the mailer no longer logs the body.)
		if c.EmailEnabled && (c.SMTPHost == "" || c.SMTPUser == "" || c.SMTPPass == "") {
			errs = append(errs, "PGSTACK_ENV=production: SMTP_HOST, SMTP_USER and SMTP_PASS are required when email is enabled — configure SMTP, or set EMAIL_ENABLED=false for an email-free (e.g. OAuth-only) deployment")
		}
	}
	if c.RequireEmailVerification && !c.EmailEnabled {
		errs = append(errs, "REQUIRE_EMAIL_VERIFICATION=true is incompatible with EMAIL_ENABLED=false — email verification needs a delivery channel")
	}
	if c.RequireEmailVerification && c.EmailEnabled && c.SMTPHost == "" {
		errs = append(errs, "REQUIRE_EMAIL_VERIFICATION=true but SMTP_HOST is not set")
	}
	if c.MaxConnections < 1 {
		errs = append(errs, "MAX_CONNECTIONS must be >= 1")
	}
	if c.GzipLevel < 0 || c.GzipLevel > 9 {
		errs = append(errs, fmt.Sprintf("GZIP_LEVEL=%d must be 0-9 (0=disabled)", c.GzipLevel))
	}
	if c.PGPoolMaxConns < 1 {
		errs = append(errs, "PG_POOL_MAX_CONNS must be >= 1")
	}
	switch c.TLSMode {
	case "off":
		// no-op
	case "auto":
		if len(c.TLSDomains) == 0 {
			errs = append(errs, "TLS_MODE=auto requires TLS_DOMAINS (comma-separated domain list)")
		}
	case "manual":
		if c.TLSCertFile == "" || c.TLSKeyFile == "" {
			errs = append(errs, "TLS_MODE=manual requires TLS_CERT_FILE and TLS_KEY_FILE")
		}
	default:
		errs = append(errs, fmt.Sprintf("TLS_MODE=%q is invalid (use off, auto, or manual)", c.TLSMode))
	}
	switch c.StorageBackend {
	case "", "database", "disk":
		// valid
	default:
		errs = append(errs, fmt.Sprintf("STORAGE_BACKEND=%q is invalid (use database or disk)", c.StorageBackend))
	}
	if c.AccessTokenExpirySecs < 60 {
		errs = append(errs, fmt.Sprintf(
			"ACCESS_TOKEN_EXPIRY_SECS=%d is dangerously short (minimum 60s recommended)",
			c.AccessTokenExpirySecs,
		))
	}
	return errs
}
