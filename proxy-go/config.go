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
	ListenAddr  string

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
	AuthRateLimit  int
	AuthRateWindow time.Duration

	// Token expiry
	AccessTokenExpirySecs  int
	RefreshTokenExpiryDays int

	// WebSocket
	BroadcastCapacity int

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
	EmbeddedFunctions   bool // enable goja embedded JS functions (always true in embedded runtime)
	AllowPermissiveCORS    bool // when AllowedOrigins is empty, reflect any Origin (DEV ONLY)
	RequireAuthenticatedWS bool // when true, anon-key WS subscriptions are rejected (JWT required)

	// SecretsEncryptionKey is the raw 32-byte AES-256 key used to encrypt
	// at-rest credentials (edge function env vars). Nil/empty when
	// SECRETS_ENCRYPTION_KEY env is unset. Sourced via secrets.DecodeKey from
	// the base64 env value.
	SecretsEncryptionKey []byte

	// CORS
	AllowedOrigins []string

	// Trusted reverse proxies (for X-Forwarded-For)
	TrustedProxies []string

	// SMTP / email
	SMTPFrom                 string
	RequireEmailVerification bool
	SMTPHost                 string
	SMTPPort                 int
	SMTPUser                 string
	SMTPPass                 string

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
	cfg.ListenAddr = envOrDefault("LISTEN_ADDR", "0.0.0.0:8080")
	cfg.PgstackEnv = strings.ToLower(os.Getenv("PGSTACK_ENV"))

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

	cfg.AccessTokenExpirySecs = envIntOrDefault("ACCESS_TOKEN_EXPIRY_SECS", 3600)
	cfg.RefreshTokenExpiryDays = envIntOrDefault("REFRESH_TOKEN_EXPIRY_DAYS", 30)

	cfg.BroadcastCapacity = envIntOrDefault("BROADCAST_CAPACITY", 1024)

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

	cfg.SMTPFrom = envOrDefault("SMTP_FROM", "noreply@pgstack.local")
	cfg.RequireEmailVerification = envBoolOrDefault("REQUIRE_EMAIL_VERIFICATION", false)
	cfg.SMTPHost = os.Getenv("SMTP_HOST")
	cfg.SMTPPort = envIntOrDefault("SMTP_PORT", 587)
	cfg.SMTPUser = os.Getenv("SMTP_USER")
	cfg.SMTPPass = os.Getenv("SMTP_PASS")

	cfg.StudioDir = envOrDefault("STUDIO_DIR", "/studio")
	cfg.DocsDir = envOrDefault("DOCS_DIR", "/docs")
	cfg.PublicDir = os.Getenv("PUBLIC_DIR")
	cfg.PublicAllowInlineScripts = envBoolOrDefault("PUBLIC_ALLOW_INLINE_SCRIPTS", false)

	cfg.StorageBackend = envOrDefault("STORAGE_BACKEND", "database")
	cfg.StorageDir = envOrDefault("STORAGE_DIR", "/data/storage")

	cfg.EdgeRuntimeURL = os.Getenv("EDGE_RUNTIME_URL") // empty = disabled

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
		if strings.Contains(c.JWTSecret, "dev-only") {
			errs = append(errs, "PGSTACK_ENV=production: JWT_SECRET still contains 'dev-only' — generate a real key with `openssl rand -base64 32`")
		}
		if strings.Contains(c.AnonKey, "dev-only") || c.AnonKey == "anon-key-12345" {
			errs = append(errs, "PGSTACK_ENV=production: ANON_KEY is a publicly-known dev value — generate a real key")
		}
		if strings.Contains(c.ServiceRoleKey, "dev-only") {
			errs = append(errs, "PGSTACK_ENV=production: SERVICE_ROLE_KEY is a publicly-known dev value — generate a real key")
		}
		if c.EnableSQLEndpoint {
			errs = append(errs, "PGSTACK_ENV=production: ENABLE_SQL_ENDPOINT=true is unsafe — raw SQL execution must not be reachable from the network")
		}
		if c.AllowPermissiveCORS {
			errs = append(errs, "PGSTACK_ENV=production: ALLOW_PERMISSIVE_CORS=true reflects any Origin with credentials — set ALLOWED_ORIGINS instead")
		}
		if !c.RequireAuthenticatedWS && c.JWTSecret != "" && c.AnonKey != "" {
			errs = append(errs, "PGSTACK_ENV=production: REQUIRE_AUTHENTICATED_WS=false lets anon-key holders open any live-query WS — set REQUIRE_AUTHENTICATED_WS=true")
		}
		if len(c.SecretsEncryptionKey) == 0 {
			errs = append(errs, "PGSTACK_ENV=production: SECRETS_ENCRYPTION_KEY is required (at-rest encryption for edge function env vars)")
		}
	}
	if c.RequireEmailVerification && c.SMTPHost == "" {
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
