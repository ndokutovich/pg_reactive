package auth

import (
	"context"
	"encoding/base64"
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

// Gate-on: a guest gets a REAL account as the FOURTH principal (0.3.0).
// Strict mode (default): role=anonymous, so `TO authenticated` policies never
// match a guest (SECURITY.md INV-A). The JWT carries is_anonymous either way
// (INV-B: derived from the row at every mint site). Needs a database — having
// one is the point. Opt in with PGSTACK_TEST_DSN pointing at a booted pgstack:
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

	for _, tc := range []struct {
		name     string
		cfgRole  string // Deps.AnonymousRole ("" exercises the zero-value fallback)
		wantRole string
	}{
		{"strict (default): role=anonymous", "anonymous", "anonymous"},
		{"zero-value falls back to strict", "", "anonymous"},
		{"compat: ANONYMOUS_ROLE=authenticated", "authenticated", "authenticated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{
				Pool:                   pool,
				JWTSecret:              secret,
				AllowAnonymousSignin:   true,
				AnonymousJWTTTLSecs:    900,
				AnonymousRole:          tc.cfgRole,
				RefreshTokenExpiryDays: 30,
				AccessTokenExpirySecs:  3600,
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
			t.Cleanup(func() {
				_, _ = pool.Exec(context.Background(), `DELETE FROM pgstack.users WHERE id = $1`, resp.User.ID)
			})
			if resp.AccessToken == "" {
				t.Fatal("access_token is empty")
			}
			if resp.ExpiresIn != 900 {
				t.Errorf("expires_in = %d, want 900 — AnonymousJWTTTLSecs still governs the access token", resp.ExpiresIn)
			}
			if resp.RefreshToken == "" {
				t.Error("refresh_token is empty — a guest that cannot refresh loses the account on reload")
			}
			if !resp.User.IsAnonymous {
				t.Error("user.is_anonymous = false, want true")
			}
			if resp.User.Role != tc.wantRole {
				t.Errorf("user.role = %q, want %q", resp.User.Role, tc.wantRole)
			}
			if resp.User.Provider != "anonymous" {
				t.Errorf("user.provider = %q, want anonymous", resp.User.Provider)
			}
			if _, err := uuid.Parse(resp.User.ID); err != nil {
				t.Errorf("user.id = %q, want UUID: %v", resp.User.ID, err)
			}

			// The row is the point: what every "is this a real user" check consults.
			var rowRole, provider, email string
			err = pool.QueryRow(context.Background(),
				`SELECT role, provider, email FROM pgstack.users WHERE id = $1`, resp.User.ID).
				Scan(&rowRole, &provider, &email)
			if err != nil {
				t.Fatalf("the guest has no row in pgstack.users: %v", err)
			}
			if rowRole != tc.wantRole {
				t.Errorf("row role = %q, want %q", rowRole, tc.wantRole)
			}
			if provider != "anonymous" {
				t.Errorf("row provider = %q, want anonymous", provider)
			}
			if !strings.HasSuffix(email, anonymousEmailDomain) {
				t.Errorf("row email = %q, want a reserved .invalid address", email)
			}

			// The minted JWT round-trips through the proxy's own validator with
			// the same role/sub, expires, and carries is_anonymous (INV-B).
			claims, err := ValidateToken(resp.AccessToken, secret)
			if err != nil {
				t.Fatalf("ValidateToken: %v", err)
			}
			if claims.Role != tc.wantRole {
				t.Errorf("claim role = %q, want %q", claims.Role, tc.wantRole)
			}
			if claims.Sub != resp.User.ID {
				t.Errorf("claim sub = %q, want %q", claims.Sub, resp.User.ID)
			}
			if claims.Exp == 0 {
				t.Error("claim exp is zero — anonymous tokens MUST expire")
			}
			if !jwtPayloadHasAnonymous(t, resp.AccessToken) {
				t.Error("access token payload lacks is_anonymous:true")
			}

			// Rotation (INV-B + D7): the refreshed access token still carries
			// is_anonymous and still uses the guest TTL, derived from the ROW.
			rec2 := httptest.NewRecorder()
			body := strings.NewReader(`{"grant_type":"refresh_token","refresh_token":"` + resp.RefreshToken + `"}`)
			r2 := httptest.NewRequest(http.MethodPost, "/auth/v1/token", body)
			Token(d).ServeHTTP(rec2, r2)
			if rec2.Code != http.StatusOK {
				t.Fatalf("refresh status = %d, body=%s", rec2.Code, rec2.Body.String())
			}
			var rot AuthResponse
			if err := json.Unmarshal(rec2.Body.Bytes(), &rot); err != nil {
				t.Fatalf("decode refresh response: %v", err)
			}
			if rot.ExpiresIn != 900 {
				t.Errorf("refreshed expires_in = %d, want 900 — the guest TTL must survive rotation (D7)", rot.ExpiresIn)
			}
			if !jwtPayloadHasAnonymous(t, rot.AccessToken) {
				t.Error("refreshed token lost is_anonymous — INV-B says it derives from the row, not the old token")
			}
			if !rot.User.IsAnonymous {
				t.Error("refreshed user.is_anonymous = false, want true")
			}
		})
	}
}

// jwtPayloadHasAnonymous decodes the (already signature-verified elsewhere)
// payload segment and reports whether is_anonymous is literally true.
func jwtPayloadHasAnonymous(t *testing.T, token string) bool {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("malformed JWT: %d segments", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	v, ok := m["is_anonymous"].(bool)
	return ok && v
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
