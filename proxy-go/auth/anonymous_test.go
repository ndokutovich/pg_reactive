package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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

// Gate-on: a guest gets a REAL account. Needs a database, because that is now
// the point — the handler used to mint a token for a `sub` no table had ever
// heard of, and everything that verifies a caller against pgstack.users refused
// it. Opt in with PGSTACK_TEST_DSN pointing at a booted pgstack:
//
//	PGSTACK_TEST_DSN=postgres://postgres:<pw>@127.0.0.1:5432/pgstack go test ./auth/
func TestAnonymous_GateOnCreatesRealAccount(t *testing.T) {
	dsn := os.Getenv("PGSTACK_TEST_DSN")
	if dsn == "" {
		t.Skip("PGSTACK_TEST_DSN not set — anonymous signin writes a row and cannot be unit-tested")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	secret := "test-secret-32-chars-xxxxxxxxxx"
	d := &Deps{
		Pool:                   pool,
		JWTSecret:              secret,
		AllowAnonymousSignin:   true,
		AnonymousJWTTTLSecs:    900,
		RefreshTokenExpiryDays: 30,
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
		t.Errorf("expires_in = %d, want 900 — AnonymousJWTTTLSecs still governs the access token", resp.ExpiresIn)
	}
	if resp.RefreshToken == "" {
		t.Error("refresh_token is empty — a guest that cannot refresh loses the account on reload, which is the whole thing this exists to prevent")
	}
	if !resp.User.IsAnonymous {
		t.Error("user.is_anonymous = false, want true")
	}
	if resp.User.Role != "authenticated" {
		t.Errorf("user.role = %q, want authenticated — RLS policies are written TO authenticated", resp.User.Role)
	}
	if resp.User.Provider != "anonymous" {
		t.Errorf("user.provider = %q, want anonymous", resp.User.Provider)
	}
	if _, err := uuid.Parse(resp.User.ID); err != nil {
		t.Errorf("user.id = %q, want UUID: %v", resp.User.ID, err)
	}

	// The row is the point: this is what net_load_loadout and every other
	// "is this a real user" check consults.
	var provider, email string
	err = pool.QueryRow(context.Background(),
		`SELECT provider, email FROM pgstack.users WHERE id = $1`, resp.User.ID).Scan(&provider, &email)
	if err != nil {
		t.Fatalf("the guest has no row in pgstack.users: %v", err)
	}
	if provider != "anonymous" {
		t.Errorf("row provider = %q, want anonymous", provider)
	}
	if !strings.HasSuffix(email, anonymousEmailDomain) {
		t.Errorf("row email = %q, want a reserved .invalid address", email)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM pgstack.users WHERE id = $1`, resp.User.ID)
	})

	// The minted JWT must round-trip through the proxy's own validator
	// with the same role and sub — the WS gate will run this same check.
	claims, err := ValidateToken(resp.AccessToken, secret)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.Role != "authenticated" {
		t.Errorf("claim role = %q, want authenticated", claims.Role)
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
