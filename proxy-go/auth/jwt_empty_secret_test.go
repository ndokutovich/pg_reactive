package auth

// Round-26 F1 (CRITICAL) regression tests. Empty JWT_SECRET must NEVER
// silently authenticate anyone. ValidateToken with secret="" would
// otherwise verify against []byte("") — i.e. any forged HS256 token
// passes. The production validator already refuses to boot with an
// empty secret, but the auth path itself must fail-closed in dev /
// test / mis-configured deployments too.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestGenerateToken_EmptySecretRefuses(t *testing.T) {
	_, err := GenerateToken("00000000-0000-0000-0000-000000000001", "authenticated", "u@example.com", "", 3600)
	if err == nil {
		t.Fatal("GenerateToken with empty secret must error, returned a token")
	}
	if !strings.Contains(err.Error(), "JWT_SECRET") {
		t.Errorf("error should mention JWT_SECRET; got: %v", err)
	}
}

func TestValidateToken_EmptySecretRefuses(t *testing.T) {
	// Forge an HS256 token signed with the empty key — exactly the
	// attack the round-26 audit flagged.
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":  "00000000-0000-0000-0000-000000000001",
		"role": "service_role",
	})
	signed, err := tok.SignedString([]byte(""))
	if err != nil {
		t.Fatalf("forge token: %v", err)
	}

	if _, err := ValidateToken(signed, ""); err == nil {
		t.Fatal("ValidateToken with empty secret accepted a forged token — auth bypass")
	}
}

func TestValidateToken_NonEmptySecretRejectsEmptyForgedToken(t *testing.T) {
	// Sanity: when a real secret IS configured, a forged-with-empty-key
	// token must still be rejected (sig mismatch).
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "attacker",
	})
	forged, _ := tok.SignedString([]byte(""))

	if _, err := ValidateToken(forged, "real-secret-32-chars-xxxxxxxxxx"); err == nil {
		t.Fatal("real secret must reject empty-key forged token")
	}
}

func TestRequireJWT_EmptySecretRefuses(t *testing.T) {
	// Even with a syntactically valid Bearer header, requireJWT must
	// refuse when the configured secret is empty. The short-circuit at
	// the top means logs say "auth not configured" instead of "invalid
	// token" — clearer signal for the operator.
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/user", nil)
	r.Header.Set("Authorization", "Bearer anything-at-all")

	if claims := requireJWT(rec, r, ""); claims != nil {
		t.Fatal("requireJWT with empty secret returned claims — auth bypass")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
