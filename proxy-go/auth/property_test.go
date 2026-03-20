package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// genUUID generates a random UUID-like string (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).
func genUUID(t *rapid.T, label string) string {
	return rapid.StringMatching(
		`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`,
	).Draw(t, label)
}

// genRole picks a valid role from the proxy's role set.
func genRole(t *rapid.T, label string) string {
	return rapid.SampledFrom([]string{"anon", "authenticated", "service_role"}).Draw(t, label)
}

// genEmail generates a plausible email string.
func genEmail(t *rapid.T, label string) string {
	user := rapid.StringMatching(`[a-z]{1,10}`).Draw(t, label+"_user")
	domain := rapid.StringMatching(`[a-z]{2,6}`).Draw(t, label+"_domain")
	tld := rapid.SampledFrom([]string{"com", "org", "net", "io"}).Draw(t, label+"_tld")
	return user + "@" + domain + "." + tld
}

// genSecret generates a JWT secret that is at least 32 characters.
func genSecret(t *rapid.T, label string) string {
	return rapid.StringMatching(`[a-zA-Z0-9!@#%^&*]{32,64}`).Draw(t, label)
}

// genPassword generates a random password 1-100 characters long.
func genPassword(t *rapid.T, label string) string {
	return rapid.StringMatching(`.{1,100}`).Draw(t, label)
}

// ---------------------------------------------------------------------------
// JWT Property 1: GenerateToken round-trip
// ---------------------------------------------------------------------------

func TestProperty_JWT_GenerateTokenRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		sub := genUUID(t, "sub")
		role := genRole(t, "role")
		email := genEmail(t, "email")
		secret := genSecret(t, "secret")
		expiry := rapid.IntRange(60, 86400).Draw(t, "expiry")

		tokenStr, err := GenerateToken(sub, role, email, secret, expiry)
		if err != nil {
			t.Fatalf("GenerateToken failed: %v", err)
		}

		claims, err := ValidateToken(tokenStr, secret)
		if err != nil {
			t.Fatalf("ValidateToken failed: %v", err)
		}

		if claims.Sub != sub {
			t.Fatalf("Sub mismatch: got %q, want %q", claims.Sub, sub)
		}
		if claims.Role != role {
			t.Fatalf("Role mismatch: got %q, want %q", claims.Role, role)
		}
		if claims.Email != email {
			t.Fatalf("Email mismatch: got %q, want %q", claims.Email, email)
		}
	})
}

// ---------------------------------------------------------------------------
// JWT Property 2: ValidateToken rejects tampered tokens
// ---------------------------------------------------------------------------

func TestProperty_JWT_RejectsTamperedToken(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		sub := genUUID(t, "sub")
		role := genRole(t, "role")
		secret := genSecret(t, "secret")

		tokenStr, err := GenerateToken(sub, role, "", secret, 3600)
		if err != nil {
			t.Fatalf("GenerateToken failed: %v", err)
		}

		// Use a completely different secret to validate -- this guarantees the
		// signature will never match, unlike single-character flipping which
		// can occasionally produce a valid base64 decode that collides.
		wrongSecret := genSecret(t, "wrong_secret")
		if wrongSecret == secret {
			return // astronomically unlikely, but skip
		}

		_, err = ValidateToken(tokenStr, wrongSecret)
		if err == nil {
			t.Fatal("ValidateToken should reject token verified with wrong secret")
		}
	})
}

// ---------------------------------------------------------------------------
// JWT Property 3: ValidateToken rejects expired tokens
// ---------------------------------------------------------------------------

func TestProperty_JWT_RejectsExpiredToken(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		sub := genUUID(t, "sub")
		role := genRole(t, "role")
		secret := genSecret(t, "secret")

		// Create a token with exp in the past (beyond the 60s leeway).
		now := time.Now().UTC()
		pastExp := now.Add(-2 * time.Hour)

		mc := jwt.MapClaims{
			"sub":  sub,
			"role": role,
			"iat":  now.Add(-3 * time.Hour).Unix(),
			"exp":  pastExp.Unix(),
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodHS256, mc)
		tokenStr, err := tok.SignedString([]byte(secret))
		if err != nil {
			t.Fatalf("sign failed: %v", err)
		}

		_, err = ValidateToken(tokenStr, secret)
		if err == nil {
			t.Fatal("ValidateToken should reject expired token")
		}
	})
}

// ---------------------------------------------------------------------------
// JWT Property 4: ValidateToken enforces max age for iat-only tokens
// ---------------------------------------------------------------------------

func TestProperty_JWT_EnforcesMaxAgeForIatOnly(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		sub := genUUID(t, "sub")
		role := genRole(t, "role")
		secret := genSecret(t, "secret")

		// iat more than 24 hours ago, no exp claim.
		hoursAgo := rapid.IntRange(25, 72).Draw(t, "hours_ago")
		oldIat := time.Now().UTC().Add(-time.Duration(hoursAgo) * time.Hour)

		mc := jwt.MapClaims{
			"sub":  sub,
			"role": role,
			"iat":  oldIat.Unix(),
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodHS256, mc)
		tokenStr, err := tok.SignedString([]byte(secret))
		if err != nil {
			t.Fatalf("sign failed: %v", err)
		}

		_, err = ValidateToken(tokenStr, secret)
		if err == nil {
			t.Fatal("ValidateToken should reject token with iat > 24h ago and no exp")
		}
		if !strings.Contains(err.Error(), "iat too old") {
			t.Fatalf("expected 'iat too old' error, got: %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Password Property 5: HashPassword round-trip
// ---------------------------------------------------------------------------

func TestProperty_Password_HashRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		password := genPassword(t, "password")

		hash, err := HashPassword(password)
		if err != nil {
			t.Fatalf("HashPassword failed: %v", err)
		}

		ok, err := VerifyPassword(password, hash)
		if err != nil {
			t.Fatalf("VerifyPassword failed: %v", err)
		}
		if !ok {
			t.Fatal("VerifyPassword should return true for the same password")
		}
	})
}

// ---------------------------------------------------------------------------
// Password Property 6: VerifyPassword rejects wrong password
// ---------------------------------------------------------------------------

func TestProperty_Password_RejectsWrongPassword(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		correct := genPassword(t, "correct")
		wrong := genPassword(t, "wrong")

		// Ensure they are actually different.
		if correct == wrong {
			return // skip this case
		}

		hash, err := HashPassword(correct)
		if err != nil {
			t.Fatalf("HashPassword failed: %v", err)
		}

		ok, err := VerifyPassword(wrong, hash)
		if err != nil {
			t.Fatalf("VerifyPassword error: %v", err)
		}
		if ok {
			t.Fatalf("VerifyPassword should return false for wrong password (correct=%q, wrong=%q)", correct, wrong)
		}
	})
}

// ---------------------------------------------------------------------------
// Password Property 7: HashPassword always produces unique hashes (random salt)
// ---------------------------------------------------------------------------

func TestProperty_Password_UniqueHashes(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		password := genPassword(t, "password")

		hash1, err := HashPassword(password)
		if err != nil {
			t.Fatalf("HashPassword(1) failed: %v", err)
		}
		hash2, err := HashPassword(password)
		if err != nil {
			t.Fatalf("HashPassword(2) failed: %v", err)
		}

		if hash1 == hash2 {
			t.Fatalf("hashing the same password twice produced identical hashes: %q", hash1)
		}
	})
}

// ---------------------------------------------------------------------------
// Password Property 8: Hash format invariant
// ---------------------------------------------------------------------------

func TestProperty_Password_HashFormatInvariant(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		password := genPassword(t, "password")

		hash, err := HashPassword(password)
		if err != nil {
			t.Fatalf("HashPassword failed: %v", err)
		}

		if !strings.HasPrefix(hash, "$argon2id$") {
			t.Fatalf("hash does not start with $argon2id$: %q", hash)
		}

		// PHC format: $argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>
		// Splitting by "$" gives: ["", "argon2id", "v=19", "m=...,t=...,p=...", "<salt>", "<hash>"]
		parts := strings.Split(hash, "$")
		if len(parts) != 6 {
			t.Fatalf("expected 6 $-delimited parts, got %d: %q", len(parts), hash)
		}
		if parts[0] != "" {
			t.Fatalf("first part should be empty, got %q", parts[0])
		}
		if parts[1] != "argon2id" {
			t.Fatalf("algorithm should be argon2id, got %q", parts[1])
		}
		if parts[2] != "v=19" {
			t.Fatalf("version should be v=19, got %q", parts[2])
		}
		if !strings.Contains(parts[3], "m=") || !strings.Contains(parts[3], "t=") || !strings.Contains(parts[3], "p=") {
			t.Fatalf("params part missing m/t/p: %q", parts[3])
		}
		if len(parts[4]) == 0 {
			t.Fatal("salt part is empty")
		}
		if len(parts[5]) == 0 {
			t.Fatal("hash part is empty")
		}
	})
}
