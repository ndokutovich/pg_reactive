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
	MaxBodySize int64

	// PG listener reconnect
	PGReconnectMaxBackoff time.Duration

	// Feature flags
	EnableSQLEndpoint bool

	// CORS
	AllowedOrigins []string

	// SMTP / email
	SMTPFrom                 string
	RequireEmailVerification bool
	SMTPHost                 string
	SMTPPort                 int
	SMTPUser                 string
	SMTPPass                 string

	// Studio SPA
	StudioDir string

	// User static files (public/ directory)
	PublicDir string
}

// FromEnv loads configuration from environment variables, applying defaults.
func FromEnv() Config {
	cfg := Config{}

	cfg.DatabaseURL = envOrDefault("DATABASE_URL", "postgres://postgres:postgres@db:5432/app")
	cfg.ListenAddr = envOrDefault("LISTEN_ADDR", "0.0.0.0:8080")

	cfg.JWTSecret = os.Getenv("JWT_SECRET")
	if cfg.JWTSecret != "" && len(cfg.JWTSecret) < 32 {
		panic(fmt.Sprintf(
			"JWT_SECRET must be at least 32 characters (got %d). Use a cryptographically random string for security.",
			len(cfg.JWTSecret),
		))
	}

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

	pgBackoff := envIntOrDefault("PG_RECONNECT_MAX_BACKOFF", 30)
	cfg.PGReconnectMaxBackoff = time.Duration(pgBackoff) * time.Second

	cfg.EnableSQLEndpoint = envBoolOrDefault("ENABLE_SQL_ENDPOINT", false)

	rawOrigins := os.Getenv("ALLOWED_ORIGINS")
	if rawOrigins != "" {
		for _, o := range strings.Split(rawOrigins, ",") {
			if trimmed := strings.TrimSpace(o); trimmed != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, trimmed)
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
	cfg.PublicDir = os.Getenv("PUBLIC_DIR")

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
	if v := os.Getenv(key); v != "" {
		return v == "true" || v == "1"
	}
	return def
}
