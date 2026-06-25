package main

import (
	"os"
	"testing"
	"time"
)

// setEnvs sets env vars and returns a cleanup function that restores originals.
func setEnvs(t *testing.T, vars map[string]string) {
	t.Helper()
	originals := make(map[string]string, len(vars))
	for k, v := range vars {
		originals[k] = os.Getenv(k)
		os.Setenv(k, v)
	}
	t.Cleanup(func() {
		for k, orig := range originals {
			if orig == "" {
				os.Unsetenv(k)
			} else {
				os.Setenv(k, orig)
			}
		}
	})
}

// --- FromEnv defaults ---

func TestFromEnv_Defaults(t *testing.T) {
	// Clear all env vars that FromEnv reads so we get pure defaults.
	setEnvs(t, map[string]string{
		"DATABASE_URL":     "",
		"LISTEN_ADDR":      "",
		"JWT_SECRET":       "",
		"READ_TIMEOUT":     "",
		"WRITE_TIMEOUT":    "",
		"IDLE_TIMEOUT":     "",
		"SHUTDOWN_TIMEOUT": "",
		"GZIP_LEVEL":       "",
		"PG_POOL_MAX_CONNS":        "",
		"PG_POOL_MIN_CONNS":        "",
		"PG_POOL_MAX_CONN_IDLE_TIME": "",
		"TLS_MODE":         "",
		"TLS_DOMAINS":      "",
		"TLS_CERT_DIR":     "",
		"HTTPS_ADDR":       "",
		"HTTP_ADDR":        "",
	})

	cfg := FromEnv()

	if cfg.ListenAddr != "0.0.0.0:8080" {
		t.Errorf("ListenAddr: got %q, want 0.0.0.0:8080", cfg.ListenAddr)
	}
	if cfg.ReadTimeout != 30*time.Second {
		t.Errorf("ReadTimeout: got %v, want 30s", cfg.ReadTimeout)
	}
	if cfg.WriteTimeout != 60*time.Second {
		t.Errorf("WriteTimeout: got %v, want 60s", cfg.WriteTimeout)
	}
	if cfg.IdleTimeout != 120*time.Second {
		t.Errorf("IdleTimeout: got %v, want 120s", cfg.IdleTimeout)
	}
	if cfg.ShutdownTimeout != 15*time.Second {
		t.Errorf("ShutdownTimeout: got %v, want 15s", cfg.ShutdownTimeout)
	}
	if cfg.GzipLevel != 5 {
		t.Errorf("GzipLevel: got %d, want 5", cfg.GzipLevel)
	}
	if cfg.PGPoolMaxConns != 50 {
		t.Errorf("PGPoolMaxConns: got %d, want 50", cfg.PGPoolMaxConns)
	}
	if cfg.PGPoolMinConns != 5 {
		t.Errorf("PGPoolMinConns: got %d, want 5", cfg.PGPoolMinConns)
	}
	if cfg.PGPoolMaxConnIdleTime != 300*time.Second {
		t.Errorf("PGPoolMaxConnIdleTime: got %v, want 300s", cfg.PGPoolMaxConnIdleTime)
	}
	if cfg.TLSMode != "off" {
		t.Errorf("TLSMode: got %q, want off", cfg.TLSMode)
	}
	if cfg.TLSCertDir != "/data/certs" {
		t.Errorf("TLSCertDir: got %q, want /data/certs", cfg.TLSCertDir)
	}
	if cfg.HTTPSAddr != ":443" {
		t.Errorf("HTTPSAddr: got %q, want :443", cfg.HTTPSAddr)
	}
	if cfg.HTTPAddr != ":80" {
		t.Errorf("HTTPAddr: got %q, want :80", cfg.HTTPAddr)
	}
	if cfg.MaxBodySize != 1024*1024 {
		t.Errorf("MaxBodySize: got %d, want 1048576", cfg.MaxBodySize)
	}
}

// --- FromEnv overrides ---

func TestFromEnv_Overrides(t *testing.T) {
	setEnvs(t, map[string]string{
		"READ_TIMEOUT":     "10",
		"WRITE_TIMEOUT":    "20",
		"IDLE_TIMEOUT":     "30",
		"SHUTDOWN_TIMEOUT": "5",
		"GZIP_LEVEL":       "9",
		"PG_POOL_MAX_CONNS":        "100",
		"PG_POOL_MIN_CONNS":        "10",
		"PG_POOL_MAX_CONN_IDLE_TIME": "600",
		"TLS_MODE":         "auto",
		"TLS_DOMAINS":      "example.com, app.example.com",
		"TLS_CERT_DIR":     "/custom/certs",
		"TLS_ACME_EMAIL":   "admin@example.com",
		"HTTPS_ADDR":       ":8443",
		"HTTP_ADDR":        ":8080",
	})

	cfg := FromEnv()

	if cfg.ReadTimeout != 10*time.Second {
		t.Errorf("ReadTimeout: got %v, want 10s", cfg.ReadTimeout)
	}
	if cfg.WriteTimeout != 20*time.Second {
		t.Errorf("WriteTimeout: got %v, want 20s", cfg.WriteTimeout)
	}
	if cfg.GzipLevel != 9 {
		t.Errorf("GzipLevel: got %d, want 9", cfg.GzipLevel)
	}
	if cfg.PGPoolMaxConns != 100 {
		t.Errorf("PGPoolMaxConns: got %d, want 100", cfg.PGPoolMaxConns)
	}
	if cfg.PGPoolMinConns != 10 {
		t.Errorf("PGPoolMinConns: got %d, want 10", cfg.PGPoolMinConns)
	}
	if cfg.TLSMode != "auto" {
		t.Errorf("TLSMode: got %q, want auto", cfg.TLSMode)
	}
	if len(cfg.TLSDomains) != 2 {
		t.Fatalf("TLSDomains: got %d domains, want 2", len(cfg.TLSDomains))
	}
	if cfg.TLSDomains[0] != "example.com" {
		t.Errorf("TLSDomains[0]: got %q, want example.com", cfg.TLSDomains[0])
	}
	if cfg.TLSDomains[1] != "app.example.com" {
		t.Errorf("TLSDomains[1]: got %q, want app.example.com", cfg.TLSDomains[1])
	}
	if cfg.TLSCertDir != "/custom/certs" {
		t.Errorf("TLSCertDir: got %q, want /custom/certs", cfg.TLSCertDir)
	}
	if cfg.TLSACMEEmail != "admin@example.com" {
		t.Errorf("TLSACMEEmail: got %q, want admin@example.com", cfg.TLSACMEEmail)
	}
	if cfg.HTTPSAddr != ":8443" {
		t.Errorf("HTTPSAddr: got %q, want :8443", cfg.HTTPSAddr)
	}
}

func TestFromEnv_InvalidIntFallsBackToDefault(t *testing.T) {
	setEnvs(t, map[string]string{
		"GZIP_LEVEL":       "not-a-number",
		"PG_POOL_MAX_CONNS": "abc",
	})

	cfg := FromEnv()

	if cfg.GzipLevel != 5 {
		t.Errorf("GzipLevel: got %d, want default 5 for invalid input", cfg.GzipLevel)
	}
	if cfg.PGPoolMaxConns != 50 {
		t.Errorf("PGPoolMaxConns: got %d, want default 50 for invalid input", cfg.PGPoolMaxConns)
	}
}

// --- Validate ---

func TestValidate_TLSAutoRequiresDomains(t *testing.T) {
	cfg := Config{
		TLSMode:       "auto",
		TLSDomains:    nil,
		MaxConnections: 1,
		GzipLevel:     5,
		PGPoolMaxConns: 1,
	}
	errs := cfg.Validate()
	if !containsError(errs, "TLS_DOMAINS") {
		t.Errorf("expected TLS_DOMAINS error, got: %v", errs)
	}
}

func TestValidate_TLSAutoWithDomains(t *testing.T) {
	cfg := Config{
		TLSMode:        "auto",
		TLSDomains:     []string{"example.com"},
		MaxConnections: 1,
		GzipLevel:      5,
		PGPoolMaxConns: 1,
		AccessTokenExpirySecs: 3600,
	}
	errs := cfg.Validate()
	if containsError(errs, "TLS") {
		t.Errorf("expected no TLS errors, got: %v", errs)
	}
}

func TestValidate_TLSManualRequiresCertAndKey(t *testing.T) {
	cfg := Config{
		TLSMode:        "manual",
		TLSCertFile:    "",
		TLSKeyFile:     "",
		MaxConnections: 1,
		GzipLevel:      5,
		PGPoolMaxConns: 1,
	}
	errs := cfg.Validate()
	if !containsError(errs, "TLS_CERT_FILE") {
		t.Errorf("expected TLS_CERT_FILE error, got: %v", errs)
	}
}

func TestValidate_TLSManualWithCerts(t *testing.T) {
	cfg := Config{
		TLSMode:        "manual",
		TLSCertFile:    "/certs/fullchain.pem",
		TLSKeyFile:     "/certs/privkey.pem",
		MaxConnections: 1,
		GzipLevel:      5,
		PGPoolMaxConns: 1,
		AccessTokenExpirySecs: 3600,
	}
	errs := cfg.Validate()
	if containsError(errs, "TLS") {
		t.Errorf("expected no TLS errors, got: %v", errs)
	}
}

func TestValidate_TLSModeOff(t *testing.T) {
	cfg := Config{
		TLSMode:        "off",
		MaxConnections: 1,
		GzipLevel:      5,
		PGPoolMaxConns: 1,
		AccessTokenExpirySecs: 3600,
	}
	errs := cfg.Validate()
	if containsError(errs, "TLS") {
		t.Errorf("expected no TLS errors for off mode, got: %v", errs)
	}
}

func TestValidate_TLSModeInvalid(t *testing.T) {
	cfg := Config{
		TLSMode:        "bogus",
		MaxConnections: 1,
		GzipLevel:      5,
		PGPoolMaxConns: 1,
	}
	errs := cfg.Validate()
	if !containsError(errs, "invalid") {
		t.Errorf("expected invalid TLS_MODE error, got: %v", errs)
	}
}

// --- NOTIFY_CHANNEL ---

func TestFromEnv_NotifyChannelDefault(t *testing.T) {
	setEnvs(t, map[string]string{"NOTIFY_CHANNEL": ""})
	if cfg := FromEnv(); cfg.NotifyChannel != "pgr" {
		t.Errorf("NotifyChannel default: got %q, want pgr", cfg.NotifyChannel)
	}
}

func TestFromEnv_NotifyChannelCustom(t *testing.T) {
	setEnvs(t, map[string]string{"NOTIFY_CHANNEL": "live_deltas"})
	if cfg := FromEnv(); cfg.NotifyChannel != "live_deltas" {
		t.Errorf("NotifyChannel custom: got %q, want live_deltas", cfg.NotifyChannel)
	}
}

func TestValidate_NotifyChannel(t *testing.T) {
	tests := []struct {
		name    string
		channel string
		wantErr bool
	}{
		{"default", "pgr", false},
		{"valid custom", "live_deltas", false},
		{"valid leading underscore", "_chan1", false},
		{"empty", "", true},
		{"sql injection", "pgr; DROP", true},
		{"dash", "pg-r", true},
		{"leading digit", "1chan", true},
		{"space", "pgr chan", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Config{
				TLSMode:               "off",
				GzipLevel:             5,
				MaxConnections:        1,
				PGPoolMaxConns:        1,
				AccessTokenExpirySecs: 3600,
				NotifyChannel:         tt.channel,
			}
			hasErr := containsError(cfg.Validate(), "NOTIFY_CHANNEL")
			if hasErr != tt.wantErr {
				t.Errorf("channel=%q: hasErr=%v, wantErr=%v", tt.channel, hasErr, tt.wantErr)
			}
		})
	}
}

func TestValidate_GzipLevelRange(t *testing.T) {
	tests := []struct {
		level   int
		wantErr bool
	}{
		{0, false},
		{1, false},
		{5, false},
		{9, false},
		{-1, true},
		{10, true},
	}
	for _, tt := range tests {
		cfg := Config{
			TLSMode:        "off",
			GzipLevel:      tt.level,
			MaxConnections: 1,
			PGPoolMaxConns: 1,
			AccessTokenExpirySecs: 3600,
		}
		errs := cfg.Validate()
		hasErr := containsError(errs, "GZIP_LEVEL")
		if hasErr != tt.wantErr {
			t.Errorf("GzipLevel=%d: hasErr=%v, wantErr=%v, errs=%v", tt.level, hasErr, tt.wantErr, errs)
		}
	}
}

func TestValidate_PGPoolMaxConns(t *testing.T) {
	cfg := Config{
		TLSMode:        "off",
		GzipLevel:      5,
		MaxConnections: 1,
		PGPoolMaxConns: 0,
		AccessTokenExpirySecs: 3600,
	}
	errs := cfg.Validate()
	if !containsError(errs, "PG_POOL_MAX_CONNS") {
		t.Errorf("expected PG_POOL_MAX_CONNS error for 0, got: %v", errs)
	}
}

func TestValidate_JWTSecretTooShort(t *testing.T) {
	cfg := Config{
		JWTSecret:      "short",
		TLSMode:        "off",
		GzipLevel:      5,
		MaxConnections: 1,
		PGPoolMaxConns: 1,
	}
	errs := cfg.Validate()
	if !containsError(errs, "JWT_SECRET") {
		t.Errorf("expected JWT_SECRET error, got: %v", errs)
	}
}

func TestValidate_ProductionRequiresAdminDatabaseURL(t *testing.T) {
	// PGSTACK_ENV=production without ADMIN_DATABASE_URL must error — the admin
	// pool would otherwise fall back to the data DSN, which can't assume
	// service_role once the data role is split off (gemini audit R4-2). Only the
	// ADMIN_DATABASE_URL value is toggled; other production errors are irrelevant
	// to the substring assertions.
	base := Config{
		PgstackEnv:     "production",
		TLSMode:        "off",
		GzipLevel:      5,
		MaxConnections: 1,
		PGPoolMaxConns: 1,
	}
	if errs := base.Validate(); !containsError(errs, "ADMIN_DATABASE_URL") {
		t.Errorf("expected ADMIN_DATABASE_URL error in production, got: %v", errs)
	}
	base.AdminDatabaseURL = "postgres://authenticator_admin:pw@db:5432/app"
	if errs := base.Validate(); containsError(errs, "ADMIN_DATABASE_URL") {
		t.Errorf("did not expect ADMIN_DATABASE_URL error once set, got: %v", errs)
	}
}

func TestValidate_EmailEnabledGatesSMTP(t *testing.T) {
	// EMAIL_ENABLED=true (default) in production requires SMTP; EMAIL_ENABLED=false
	// lets a no-email (e.g. OAuth-only) deployment boot without SMTP — so an
	// operator never has to disable PGSTACK_ENV=production just to skip the SMTP
	// check (which would also drop the dev-secret / SQL / CORS / WS guards).
	base := func() Config {
		return Config{
			PgstackEnv:             "production",
			JWTSecret:              "this-is-a-long-enough-secret-for-jwt-auth",
			AnonKey:                "a-real-anon-key-not-a-dev-value",
			ServiceRoleKey:         "a-real-service-role-key-not-a-dev-value",
			SecretsEncryptionKey:   []byte("0123456789abcdef0123456789abcdef"),
			AdminDatabaseURL:       "postgres://authenticator_admin:pw@db:5432/app",
			RequireAuthenticatedWS: true,
			TLSMode:                "off",
			GzipLevel:              5,
			MaxConnections:         1,
			PGPoolMaxConns:         1,
		}
	}
	// email enabled + no SMTP -> error
	c := base()
	c.EmailEnabled = true
	if errs := c.Validate(); !containsError(errs, "SMTP") {
		t.Errorf("expected SMTP error when email enabled in production, got: %v", errs)
	}
	// email disabled + no SMTP -> OK (no SMTP error)
	c = base()
	c.EmailEnabled = false
	if errs := c.Validate(); containsError(errs, "SMTP") {
		t.Errorf("did not expect SMTP error when EMAIL_ENABLED=false, got: %v", errs)
	}
	// email disabled + require verification -> incompatible
	c = base()
	c.EmailEnabled = false
	c.RequireEmailVerification = true
	if errs := c.Validate(); !containsError(errs, "EMAIL_ENABLED=false") {
		t.Errorf("expected incompatibility error for verification + email disabled, got: %v", errs)
	}
}

func TestValidate_RejectsPlaceholderAndShortSecrets(t *testing.T) {
	// The repo ships change-me-* placeholders in .env.example; compose only checks
	// non-empty, so a user who fills just what blocks startup could ship a
	// publicly-known SERVICE_ROLE_KEY. Production must reject placeholders and
	// too-short opaque keys.
	base := func() Config {
		return Config{
			PgstackEnv:             "production",
			JWTSecret:              "this-is-a-long-enough-secret-for-jwt-auth",
			AnonKey:                "real-anon-key-1234567890abcdefXYZ",
			ServiceRoleKey:         "real-service-role-key-1234567890abXYZ",
			SecretsEncryptionKey:   []byte("0123456789abcdef0123456789abcdef"),
			AdminDatabaseURL:       "postgres://authenticator_admin:pw@db:5432/app",
			RequireAuthenticatedWS: true,
			EmailEnabled:           false,
			AccessTokenExpirySecs:  3600,
			TLSMode:                "off",
			GzipLevel:              5,
			MaxConnections:         1,
			PGPoolMaxConns:         1,
			NotifyChannel:          "pgr",
		}
	}
	if errs := base().Validate(); len(errs) != 0 {
		t.Fatalf("realistic prod base should pass, got: %v", errs)
	}
	cases := []struct {
		name, want string
		mut        func(*Config)
	}{
		{"jwt change-me", "JWT_SECRET", func(c *Config) { c.JWTSecret = "change-me-at-least-32-characters-long" }},
		{"anon change-me", "ANON_KEY", func(c *Config) { c.AnonKey = "change-me-anon-key" }},
		{"service change-me", "SERVICE_ROLE_KEY", func(c *Config) { c.ServiceRoleKey = "change-me-service-role-key" }},
		{"service short", "SERVICE_ROLE_KEY", func(c *Config) { c.ServiceRoleKey = "short" }},
		{"anon short", "ANON_KEY", func(c *Config) { c.AnonKey = "short" }},
		{"anon 24 chars (below 32)", "ANON_KEY", func(c *Config) { c.AnonKey = "abcdefghij0123456789ABCD" }},
		{"service 31 chars (below 32)", "SERVICE_ROLE_KEY", func(c *Config) { c.ServiceRoleKey = "abcdefghij0123456789ABCDEFGHIJ1" }},
	}
	for _, tc := range cases {
		c := base()
		tc.mut(&c)
		if errs := c.Validate(); !containsError(errs, tc.want) {
			t.Errorf("%s: expected %s rejected, got: %v", tc.name, tc.want, errs)
		}
	}
}

func TestValidate_AllValid(t *testing.T) {
	cfg := Config{
		JWTSecret:             "this-is-a-long-enough-secret-for-jwt-auth",
		TLSMode:               "off",
		GzipLevel:             5,
		MaxConnections:        100,
		PGPoolMaxConns:        50,
		AccessTokenExpirySecs: 3600,
		NotifyChannel:         "pgr",
	}
	errs := cfg.Validate()
	if len(errs) != 0 {
		t.Errorf("expected no validation errors, got: %v", errs)
	}
}

// --- envBoolOrDefault ---

func TestEnvBoolOrDefault(t *testing.T) {
	tests := []struct {
		val  string
		def  bool
		want bool
	}{
		{"true", false, true},
		{"1", false, true},
		{"false", true, false},
		{"0", true, false},
		{"", true, true},
		{"", false, false},
		{"garbage", true, true},   // unrecognised → default
		{"garbage", false, false}, // unrecognised → default
	}

	for _, tt := range tests {
		key := "TEST_BOOL_KEY_" + tt.val
		setEnvs(t, map[string]string{key: tt.val})
		got := envBoolOrDefault(key, tt.def)
		if got != tt.want {
			t.Errorf("envBoolOrDefault(%q=%q, %v): got %v, want %v", key, tt.val, tt.def, got, tt.want)
		}
	}
}

// helper
func containsError(errs []string, substr string) bool {
	for _, e := range errs {
		if len(e) > 0 {
			lower := e
			if contains(lower, substr) {
				return true
			}
		}
	}
	return false
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
