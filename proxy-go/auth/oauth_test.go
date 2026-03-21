package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── helpers ───────────────────────────────────────────────────────────────────

// buildJWT constructs a syntactically valid three-part JWT with the given
// payload claims. The header and signature are dummy values — extractEmailFromJWT
// does not verify signatures.
func buildJWT(claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payloadBytes, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	sig := base64.RawURLEncoding.EncodeToString([]byte("fakesig"))
	return fmt.Sprintf("%s.%s.%s", header, payload, sig)
}

// ── extractEmailFromJWT ───────────────────────────────────────────────────────

func TestExtractEmailFromJWT_ValidToken(t *testing.T) {
	token := buildJWT(map[string]any{
		"sub":   "user-123",
		"email": "alice@example.com",
		"exp":   9999999999,
	})

	got, err := extractEmailFromJWT(token)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "alice@example.com" {
		t.Errorf("got email %q, want %q", got, "alice@example.com")
	}
}

func TestExtractEmailFromJWT_MissingEmailClaim(t *testing.T) {
	token := buildJWT(map[string]any{
		"sub": "user-456",
		// no "email" field
	})

	_, err := extractEmailFromJWT(token)
	if err == nil {
		t.Fatal("expected error when email claim is absent, got nil")
	}
}

func TestExtractEmailFromJWT_EmptyEmailClaim(t *testing.T) {
	token := buildJWT(map[string]any{
		"sub":   "user-789",
		"email": "",
	})

	_, err := extractEmailFromJWT(token)
	if err == nil {
		t.Fatal("expected error when email claim is empty string, got nil")
	}
}

func TestExtractEmailFromJWT_InvalidFormat_TwoParts(t *testing.T) {
	_, err := extractEmailFromJWT("header.payload")
	if err == nil {
		t.Fatal("expected error for JWT with only two parts")
	}
}

func TestExtractEmailFromJWT_InvalidFormat_OnePart(t *testing.T) {
	_, err := extractEmailFromJWT("notajwt")
	if err == nil {
		t.Fatal("expected error for single-segment string")
	}
}

func TestExtractEmailFromJWT_InvalidFormat_Empty(t *testing.T) {
	_, err := extractEmailFromJWT("")
	if err == nil {
		t.Fatal("expected error for empty string")
	}
}

func TestExtractEmailFromJWT_BadBase64Payload(t *testing.T) {
	// Construct a token whose middle segment is not valid base64url.
	token := "validheader.!!!notbase64!!!.validsig"
	_, err := extractEmailFromJWT(token)
	if err == nil {
		t.Fatal("expected error for bad base64 payload segment")
	}
}

func TestExtractEmailFromJWT_PayloadNotJSON(t *testing.T) {
	// Valid base64url but not JSON.
	payload := base64.RawURLEncoding.EncodeToString([]byte("this is not json"))
	token := fmt.Sprintf("header.%s.sig", payload)
	_, err := extractEmailFromJWT(token)
	if err == nil {
		t.Fatal("expected error when payload is not valid JSON")
	}
}

func TestExtractEmailFromJWT_NonStringEmailClaim(t *testing.T) {
	// email claim is a number, not a string.
	token := buildJWT(map[string]any{
		"email": 12345,
	})
	_, err := extractEmailFromJWT(token)
	if err == nil {
		t.Fatal("expected error when email claim is not a string")
	}
}

// ── discoverOIDCAuthEndpoint ──────────────────────────────────────────────────

func TestDiscoverOIDCAuthEndpoint_ValidDocument(t *testing.T) {
	const wantAuthEndpoint = "https://auth.example.com/oauth2/authorize"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint": wantAuthEndpoint,
			"token_endpoint":         "https://auth.example.com/oauth2/token",
			"userinfo_endpoint":      "https://auth.example.com/oauth2/userinfo",
		})
	}))
	defer srv.Close()

	got, err := discoverOIDCAuthEndpoint(srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != wantAuthEndpoint {
		t.Errorf("got %q, want %q", got, wantAuthEndpoint)
	}
}

func TestDiscoverOIDCAuthEndpoint_MissingAuthorizationEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// token_endpoint present but authorization_endpoint absent.
		_ = json.NewEncoder(w).Encode(map[string]string{
			"token_endpoint": "https://auth.example.com/oauth2/token",
		})
	}))
	defer srv.Close()

	_, err := discoverOIDCAuthEndpoint(srv.URL)
	if err == nil {
		t.Fatal("expected error when authorization_endpoint is missing from discovery doc")
	}
}

func TestDiscoverOIDCAuthEndpoint_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := discoverOIDCAuthEndpoint(srv.URL)
	if err == nil {
		t.Fatal("expected error when discovery server returns 500")
	}
}

func TestDiscoverOIDCAuthEndpoint_EmptyIssuerURL(t *testing.T) {
	_, err := discoverOIDCAuthEndpoint("")
	if err == nil {
		t.Fatal("expected error when issuer URL is empty")
	}
}

func TestDiscoverOIDCAuthEndpoint_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("this is not json"))
	}))
	defer srv.Close()

	_, err := discoverOIDCAuthEndpoint(srv.URL)
	if err == nil {
		t.Fatal("expected error when discovery document is not valid JSON")
	}
}

// ── supportedProviders ────────────────────────────────────────────────────────

func TestSupportedProviders_ContainsAllFive(t *testing.T) {
	required := []string{"google", "github", "apple", "microsoft", "oidc"}
	for _, p := range required {
		if !supportedProviders[p] {
			t.Errorf("supportedProviders is missing required provider %q", p)
		}
	}
	if len(supportedProviders) != 5 {
		t.Errorf("expected exactly 5 providers, got %d", len(supportedProviders))
	}
}

func TestSupportedProviders_UnknownProviderNotPresent(t *testing.T) {
	unknowns := []string{"twitter", "facebook", "slack", ""}
	for _, p := range unknowns {
		if supportedProviders[p] {
			t.Errorf("supportedProviders should not contain %q", p)
		}
	}
}
