package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Negative test: with the gate off (default), /auth/v1/anonymous must
// refuse to mint a token. Anything else would let any unauthenticated
// caller acquire role=anon JWTs at will and bypass the
// REQUIRE_AUTHENTICATED_WS hardening by mint-then-subscribe.
func TestAnonymous_GateOffReturns503(t *testing.T) {
	d := &Deps{
		JWTSecret:            "test-secret-32-chars-xxxxxxxxxx",
		AllowAnonymousSignin: false,
		AnonymousJWTTTLSecs:  3600,
	}

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/v1/anonymous", nil)
	Anonymous(d).ServeHTTP(rec, r)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("gate-off status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "disabled") {
		t.Errorf("body should explain the gate is off; got: %s", rec.Body.String())
	}
}

// Gate-on test: returns an AuthResponse whose access_token parses as a
// valid JWT with role=anon and sub=UUID, and whose user payload carries
// the is_anonymous flag — the shape SDKs and example pages rely on.
func TestAnonymous_GateOnIssuesValidJWT(t *testing.T) {
	secret := "test-secret-32-chars-xxxxxxxxxx"
	d := &Deps{
		JWTSecret:            secret,
		AllowAnonymousSignin: true,
		AnonymousJWTTTLSecs:  900,
	}

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/v1/anonymous", nil)
	Anonymous(d).ServeHTTP(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("gate-on status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var resp AuthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.AccessToken == "" {
		t.Fatal("access_token is empty")
	}
	if resp.TokenType != "bearer" {
		t.Errorf("token_type = %q, want bearer", resp.TokenType)
	}
	if resp.ExpiresIn != 900 {
		t.Errorf("expires_in = %d, want 900", resp.ExpiresIn)
	}
	if resp.RefreshToken != "" {
		t.Errorf("refresh_token = %q, want empty (anon must not be refreshable)", resp.RefreshToken)
	}
	if !resp.User.IsAnonymous {
		t.Error("user.is_anonymous = false, want true")
	}
	if resp.User.Role != "anon" {
		t.Errorf("user.role = %q, want anon", resp.User.Role)
	}
	if resp.User.Provider != "anonymous" {
		t.Errorf("user.provider = %q, want anonymous", resp.User.Provider)
	}
	if _, err := uuid.Parse(resp.User.ID); err != nil {
		t.Errorf("user.id = %q, want UUID: %v", resp.User.ID, err)
	}

	// The minted JWT must round-trip through the proxy's own validator
	// with the same role and sub — the WS gate will run this same check.
	claims, err := ValidateToken(resp.AccessToken, secret)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.Role != "anon" {
		t.Errorf("claim role = %q, want anon", claims.Role)
	}
	if claims.Sub != resp.User.ID {
		t.Errorf("claim sub = %q, want %q", claims.Sub, resp.User.ID)
	}
	if claims.Exp == 0 {
		t.Error("claim exp is zero — anonymous tokens MUST expire")
	}
}

// Defence-in-depth: with the gate ON but an empty JWT_SECRET, we MUST
// still refuse to mint. GenerateToken will error on empty-secret (round
// 26 F1), and the handler surfaces that as 500 — never a token signed
// with []byte("") that the validator would equally accept-by-default.
func TestAnonymous_EmptySecretRefuses(t *testing.T) {
	d := &Deps{
		JWTSecret:            "",
		AllowAnonymousSignin: true,
		AnonymousJWTTTLSecs:  3600,
	}

	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/v1/anonymous", nil)
	Anonymous(d).ServeHTTP(rec, r)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("empty-secret status = %d, want 500", rec.Code)
	}
}
