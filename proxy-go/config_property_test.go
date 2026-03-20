package main

import (
	"fmt"
	"os"
	"strconv"
	"testing"

	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// genDatabaseURL generates a plausible PostgreSQL connection string.
func genDatabaseURL(t *rapid.T, label string) string {
	user := rapid.StringMatching(`[a-z]{3,10}`).Draw(t, label+"_user")
	pass := rapid.StringMatching(`[a-zA-Z0-9]{4,16}`).Draw(t, label+"_pass")
	host := rapid.StringMatching(`[a-z]{3,10}`).Draw(t, label+"_host")
	port := rapid.IntRange(1024, 65535).Draw(t, label+"_port")
	db := rapid.StringMatching(`[a-z]{3,10}`).Draw(t, label+"_db")
	return fmt.Sprintf("postgres://%s:%s@%s:%d/%s", user, pass, host, port, db)
}

// genValidJWTSecret generates a JWT secret that is >= 32 chars and does not
// contain "dev-only".
func genValidJWTSecret(t *rapid.T, label string) string {
	// Generate 32-64 chars from a safe alphabet that cannot spell "dev-only".
	return rapid.StringMatching(`[a-zA-Z0-9!@#%^&*]{32,64}`).Draw(t, label)
}

// genShortJWTSecret generates a non-empty JWT secret that is < 32 chars.
func genShortJWTSecret(t *rapid.T, label string) string {
	length := rapid.IntRange(1, 31).Draw(t, label+"_len")
	return rapid.StringMatching(fmt.Sprintf(`[a-zA-Z0-9]{%d}`, length)).Draw(t, label)
}

// ---------------------------------------------------------------------------
// Config Property 9: Validate accepts valid configs
// ---------------------------------------------------------------------------

func TestProperty_Config_ValidateAcceptsValidConfigs(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		dbURL := genDatabaseURL(t, "db")
		jwtSecret := genValidJWTSecret(t, "jwt")
		maxConns := rapid.IntRange(1, 100000).Draw(t, "max_conns")
		gzipLevel := rapid.IntRange(0, 9).Draw(t, "gzip_level")
		pgPoolMax := rapid.IntRange(1, 1000).Draw(t, "pg_pool_max")
		tokenExpiry := rapid.IntRange(60, 86400).Draw(t, "token_expiry")

		tlsMode := rapid.SampledFrom([]string{"off", "manual"}).Draw(t, "tls_mode")

		cfg := Config{
			DatabaseURL:           dbURL,
			ListenAddr:            "0.0.0.0:8080",
			JWTSecret:             jwtSecret,
			MaxConnections:        maxConns,
			GzipLevel:             gzipLevel,
			PGPoolMaxConns:        int32(pgPoolMax),
			TLSMode:               tlsMode,
			AccessTokenExpirySecs: tokenExpiry,
		}

		// If manual TLS, provide cert and key paths.
		if tlsMode == "manual" {
			cfg.TLSCertFile = "/certs/fullchain.pem"
			cfg.TLSKeyFile = "/certs/privkey.pem"
		}

		errs := cfg.Validate()
		if len(errs) != 0 {
			t.Fatalf("expected no validation errors for valid config, got: %v\nconfig: %+v", errs, cfg)
		}
	})
}

// ---------------------------------------------------------------------------
// Config Property 10: Validate rejects short JWT_SECRET
// ---------------------------------------------------------------------------

func TestProperty_Config_ValidateRejectsShortJWTSecret(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		shortSecret := genShortJWTSecret(t, "jwt")

		cfg := Config{
			JWTSecret:             shortSecret,
			MaxConnections:        1,
			GzipLevel:             5,
			PGPoolMaxConns:        1,
			TLSMode:               "off",
			AccessTokenExpirySecs: 3600,
		}

		errs := cfg.Validate()
		found := false
		for _, e := range errs {
			if containsSubstring(e, "JWT_SECRET") && containsSubstring(e, "32") {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected JWT_SECRET validation error for %d-char secret %q, got: %v",
				len(shortSecret), shortSecret, errs)
		}
	})
}

// ---------------------------------------------------------------------------
// Config Property 11: envOrDefault returns env when set, default otherwise
// ---------------------------------------------------------------------------

func TestProperty_Config_EnvOrDefault(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Use a unique key per iteration to avoid collisions.
		suffix := rapid.StringMatching(`[A-Z]{8}`).Draw(t, "suffix")
		key := "PROP_TEST_ENV_" + suffix
		// envOrDefault treats "" as "not set", so the value must be non-empty
		// printable ASCII (no null bytes -- os.Getenv may truncate at \x00).
		val := rapid.StringMatching(`[a-zA-Z0-9_!@#]{1,50}`).Draw(t, "val")
		def := rapid.StringMatching(`[a-zA-Z0-9_!@#]{1,50}`).Draw(t, "def")

		// Test with env set.
		os.Setenv(key, val)
		got := envOrDefault(key, def)
		os.Unsetenv(key)

		if got != val {
			t.Fatalf("envOrDefault(%q, %q) with env=%q: got %q, want %q", key, def, val, got, val)
		}

		// Test with env unset.
		got = envOrDefault(key, def)
		if got != def {
			t.Fatalf("envOrDefault(%q, %q) with env unset: got %q, want %q", key, def, got, def)
		}
	})
}

// ---------------------------------------------------------------------------
// Config Property 12: getEnvInt (envIntOrDefault) returns parsed int or default
// ---------------------------------------------------------------------------

func TestProperty_Config_EnvIntOrDefault(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		suffix := rapid.StringMatching(`[A-Z]{8}`).Draw(t, "suffix")
		key := "PROP_TEST_INT_" + suffix
		intVal := rapid.IntRange(-100000, 100000).Draw(t, "intval")
		def := rapid.IntRange(-100000, 100000).Draw(t, "def")

		// Test with valid integer string in env.
		os.Setenv(key, strconv.Itoa(intVal))
		got := envIntOrDefault(key, def)
		os.Unsetenv(key)

		if got != intVal {
			t.Fatalf("envIntOrDefault(%q, %d) with env=%q: got %d, want %d",
				key, def, strconv.Itoa(intVal), got, intVal)
		}

		// Test with non-integer string in env.
		nonInt := rapid.StringMatching(`[a-z]{1,10}`).Draw(t, "nonint")
		os.Setenv(key, nonInt)
		got = envIntOrDefault(key, def)
		os.Unsetenv(key)

		if got != def {
			t.Fatalf("envIntOrDefault(%q, %d) with env=%q (non-int): got %d, want %d",
				key, def, nonInt, got, def)
		}

		// Test with env unset.
		got = envIntOrDefault(key, def)
		if got != def {
			t.Fatalf("envIntOrDefault(%q, %d) with env unset: got %d, want %d",
				key, def, got, def)
		}
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func containsSubstring(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
