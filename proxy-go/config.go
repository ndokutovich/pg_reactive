package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all proxy configuration loaded from environment variables.
type Config struct {
	// Core
	DatabaseURL string
	ListenAddr  string

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
	EnableSQLEndpoint bool
	EmbeddedFunctions bool // enable goja embedded JS functions (always true in embedded runtime)

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

	cfg.JWTSecret = os.Getenv("JWT_SECRET")

	cfg.AnonKey = os.Getenv("ANON_KEY")
	cfg.ServiceRoleKey = os.Getenv("SERVICE_ROLE_KEY")

	cfg.MaxConnections = envIntOrDefault("MAX_CONNECTIONS", 10000)

	cfg.GoogleClientID = os.Getenv("GOOGLE_CLIENT_ID")
	cfg.GoogleClientSecret = os.Getenv("GOOGLE_CLIENT_SECRET")
	cfg.GitHubClientID = os.Getenv("GITHUB_CLIENT_ID")
	cfg.GitHubClientSecret = os.Getenv("GITHUB_CLIENT_SECRET")
	cfg.SiteURL = os.Getenv("SITE_URL")

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
	cfg.EmbeddedFunctions = envBoolOrDefault("EMBEDDED_FUNCTIONS", true)

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
		errs = append(errs, "JWT_SECRET contains 'dev-only' — set a proper secret for production")
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
	if c.AccessTokenExpirySecs < 60 {
		errs = append(errs, fmt.Sprintf(
			"ACCESS_TOKEN_EXPIRY_SECS=%d is dangerously short (minimum 60s recommended)",
			c.AccessTokenExpirySecs,
		))
	}
	return errs
}
