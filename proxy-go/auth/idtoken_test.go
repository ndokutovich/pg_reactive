package auth

// Round-16 regression tests pinning the security contracts of
// verifyIDToken: signature must verify against a JWKS-resolved key,
// exp must be present and not in the past, iss/aud must match, and
// disallowed algorithms (alg=HS*) must be rejected. Each test spins up
// a local httptest.Server that serves a minimal JWKS so we do not
// depend on any real OAuth provider.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ── JWKS test server + helpers ──────────────────────────────────────────

// jwksTestSetup spins up an httptest.Server serving a JWKS document for a
// fresh P-256 key under the given kid, returns the signing key and the
// jwks_uri. The caller must defer the returned cleanup func.
func jwksTestSetup(t *testing.T, kid string) (*ecdsa.PrivateKey, string, func()) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	x := base64.RawURLEncoding.EncodeToString(key.X.Bytes())
	y := base64.RawURLEncoding.EncodeToString(key.Y.Bytes())
	doc := map[string]any{
		"keys": []map[string]any{{
			"kty": "EC",
			"crv": "P-256",
			"kid": kid,
			"alg": "ES256",
			"use": "sig",
			"x":   x,
			"y":   y,
		}},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	}))
	cleanup := func() {
		srv.Close()
		// flush cache so other tests using a different httptest URL are
		// not polluted by this one's keys.
		jwksCacheMu.Lock()
		jwksCacheMap = map[string]*cachedJWKS{}
		jwksCacheMu.Unlock()
	}
	return key, srv.URL, cleanup
}

func signES256(t *testing.T, key *ecdsa.PrivateKey, kid string, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = kid
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// ── happy path ──────────────────────────────────────────────────────────

func TestVerifyIDToken_HappyPath(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-happy")
	defer cleanup()

	token := signES256(t, key, "kid-happy", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "user@example.com",
		"email_verified": true,
	})

	email, verified, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if email != "user@example.com" {
		t.Fatalf("email: got %q want %q", email, "user@example.com")
	}
	if !verified {
		t.Fatalf("expected email_verified=true")
	}
}

// ── F2 (round 15): exp must be required ─────────────────────────────────

func TestVerifyIDToken_MissingExp_Rejected(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-noexp")
	defer cleanup()

	// No exp claim — must fail even though everything else is valid.
	token := signES256(t, key, "kid-noexp", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected error for id_token without exp, got nil")
	}
}

func TestVerifyIDToken_ExpiredExp_Rejected(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-exp")
	defer cleanup()

	token := signES256(t, key, "kid-exp", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(-1 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	_, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client")
	if err == nil {
		t.Fatal("expected error for expired id_token, got nil")
	}
	if !strings.Contains(err.Error(), "expir") && !strings.Contains(err.Error(), "exp") {
		t.Fatalf("expected exp-related error, got: %v", err)
	}
}

// ── F3 (round 13): iss + aud + signature ────────────────────────────────

func TestVerifyIDToken_WrongIss_Rejected(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-iss")
	defer cleanup()

	token := signES256(t, key, "kid-iss", jwt.MapClaims{
		"iss":            "https://attacker.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected error for wrong iss, got nil")
	}
}

func TestVerifyIDToken_WrongAud_Rejected(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-aud")
	defer cleanup()

	token := signES256(t, key, "kid-aud", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "different-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected error for wrong aud, got nil")
	}
}

func TestVerifyIDToken_AudArrayMatch_Accepted(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-audarr")
	defer cleanup()

	token := signES256(t, key, "kid-audarr", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            []string{"other-client", "pgstack-client", "third"},
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err != nil {
		t.Fatalf("expected aud-array match to succeed, got %v", err)
	}
}

func TestVerifyIDToken_WrongSignature_Rejected(t *testing.T) {
	// Sign with one key, advertise a different key in JWKS.
	_, jwksURI, cleanup := jwksTestSetup(t, "kid-sig")
	defer cleanup()

	otherKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate other key: %v", err)
	}
	token := signES256(t, otherKey, "kid-sig", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected signature mismatch to fail, got nil")
	}
}

func TestVerifyIDToken_UnknownKid_Rejected(t *testing.T) {
	key, jwksURI, cleanup := jwksTestSetup(t, "kid-known")
	defer cleanup()

	// Sign with the real key but advertise an unknown kid — verifyIDToken
	// triggers exactly one JWKS refresh and then fails closed.
	token := signES256(t, key, "kid-unknown", jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})

	if _, _, err := verifyIDToken(token, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected unknown-kid to fail, got nil")
	}
}

// ── alg-confusion footgun: HS* must be refused even when JWKS could be
// pretended to be a "secret" ─────────────────────────────────────────────

func TestVerifyIDToken_HS256_Rejected(t *testing.T) {
	_, jwksURI, cleanup := jwksTestSetup(t, "kid-hs")
	defer cleanup()

	// Build an HS256 token with the same kid as the JWKS — a classic
	// alg-confusion attack. WithValidMethods must refuse this.
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss":            "https://idp.test",
		"aud":            "pgstack-client",
		"exp":            time.Now().Add(5 * time.Minute).Unix(),
		"email":          "u@example.com",
		"email_verified": true,
	})
	tok.Header["kid"] = "kid-hs"
	signed, err := tok.SignedString([]byte("any-secret"))
	if err != nil {
		t.Fatalf("sign HS: %v", err)
	}

	if _, _, err := verifyIDToken(signed, jwksURI, IssuerEquals("https://idp.test"), "pgstack-client"); err == nil {
		t.Fatal("expected HS256 to be rejected by WithValidMethods, got nil")
	}
}

// ── audMatches: covers the three RFC 7519 shapes ────────────────────────

func TestAudMatches(t *testing.T) {
	cases := []struct {
		name string
		c    any
		want string
		ok   bool
	}{
		{"string match", "pgstack-client", "pgstack-client", true},
		{"string mismatch", "other", "pgstack-client", false},
		{"any-array match", []any{"a", "pgstack-client", "c"}, "pgstack-client", true},
		{"any-array mismatch", []any{"a", "b"}, "pgstack-client", false},
		{"string-array match", []string{"a", "pgstack-client"}, "pgstack-client", true},
		{"nil", nil, "pgstack-client", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := audMatches(c.c, c.want); got != c.ok {
				t.Fatalf("audMatches(%#v, %q): got %v, want %v", c.c, c.want, got, c.ok)
			}
		})
	}
}

// ── claimTrue ───────────────────────────────────────────────────────────

func TestClaimTrue(t *testing.T) {
	cases := []struct {
		in   any
		want bool
	}{
		{true, true},
		{false, false},
		{"true", true},
		{"TRUE", true},
		{"false", false},
		{"", false},
		{1, false},
		{nil, false},
	}
	for _, c := range cases {
		if got := claimTrue(c.in); got != c.want {
			t.Fatalf("claimTrue(%#v): got %v, want %v", c.in, got, c.want)
		}
	}
}

// Silence unused-import warning if a future refactor drops one of these.
var _ = sync.Mutex{}
