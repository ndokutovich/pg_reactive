package realtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"pgstack-proxy-go/middleware"
)

// Regression tests for the PresenceHandler gate — closes audit finding
// F3 (round 7). The handler is security-critical: before round 6 it
// was unauthenticated, and the new auth+audience policy is the only
// thing keeping presence state private. These tests pin the decision
// matrix so a future refactor can't accidentally re-open the door.

// ── gatePresenceAccess — pure decision function ─────────────────────

func TestGatePresenceAccess_NoAudience_AlwaysAllows(t *testing.T) {
	for _, c := range []middleware.RequestClaims{
		{Role: "anon"},
		{Role: "authenticated", Sub: "42", ClaimsJSON: `{"sub":"42","role":"authenticated"}`},
		{Role: "service_role"},
		{}, // auth disabled
	} {
		if status, _ := gatePresenceAccess("", true, c); status != 0 {
			t.Fatalf("public channel must allow anon role=%q, got %d", c.Role, status)
		}
		if status, _ := gatePresenceAccess("", false, c); status != 0 {
			t.Fatalf("public channel must allow JWT role=%q, got %d", c.Role, status)
		}
	}
}

func TestGatePresenceAccess_ServiceRoleBypassesAudience(t *testing.T) {
	claims := middleware.RequestClaims{
		Role:       "service_role",
		ClaimsJSON: `{"role":"service_role"}`,
	}
	if status, _ := gatePresenceAccess(`{"sub":"42"}`, false, claims); status != 0 {
		t.Fatalf("service_role must bypass audience, got %d", status)
	}
}

func TestGatePresenceAccess_AnonRejectedWhenAudienceSet(t *testing.T) {
	status, msg := gatePresenceAccess(`{"sub":"42"}`, true, middleware.RequestClaims{Role: "anon"})
	if status != http.StatusForbidden {
		t.Fatalf("anon on audience-bound channel must get 403, got %d (%s)", status, msg)
	}
}

func TestGatePresenceAccess_JWTMatchingAudienceAllowed(t *testing.T) {
	claims := middleware.RequestClaims{
		Role:       "authenticated",
		Sub:        "42",
		ClaimsJSON: `{"sub":"42","role":"authenticated"}`,
	}
	if status, _ := gatePresenceAccess(`{"sub":"42"}`, false, claims); status != 0 {
		t.Fatalf("matching JWT must be allowed, got %d", status)
	}
}

func TestGatePresenceAccess_JWTMismatchRefused(t *testing.T) {
	claims := middleware.RequestClaims{
		Role:       "authenticated",
		Sub:        "99",
		ClaimsJSON: `{"sub":"99","role":"authenticated"}`,
	}
	status, _ := gatePresenceAccess(`{"sub":"42"}`, false, claims)
	if status != http.StatusForbidden {
		t.Fatalf("mismatched JWT must get 403, got %d", status)
	}
}

// ── End-to-end: PresenceHandler with httptest ───────────────────────
//
// These tests don't need a real DB because the ad-hoc channel prefix
// (_channel_ / _presence_) bypasses subscriptionMeta. Auth-disabled mode
// (cfg.JWTSecret == "") additionally skips the auth resolution stage,
// so a happy-path GET works against the bare hub.

func serveGetPresence(t *testing.T, url string, hub *Hub, requireAuthenticated bool, jwtSecret, anonKey string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	cfg := middleware.RLSConfig{JWTSecret: jwtSecret, AnonKey: anonKey}
	r.Get("/ws/_presence/{channel}", PresenceHandler(cfg, nil, hub, requireAuthenticated))
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestPresenceHandler_AuthDisabledPublicChannel_OK(t *testing.T) {
	hub := NewHub()
	hub.PresenceJoin("_channel_lobby", "peer-1", json.RawMessage(`{"name":"alice"}`))

	rec := serveGetPresence(t, "/ws/_presence/_channel_lobby", hub, false, "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !decodeContains(t, rec.Body.Bytes(), "peer-1") {
		t.Fatalf("body missing presence row: %s", rec.Body.String())
	}
}

func TestPresenceHandler_AnonRefusedWhenRequireAuthenticated(t *testing.T) {
	hub := NewHub()
	rec := serveGetPresence(
		t,
		"/ws/_presence/_channel_lobby?apikey=anon-key-12345",
		hub,
		true, // requireAuthenticated
		"some-jwt-secret-32-chars-long-xxx",
		"anon-key-12345",
	)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon with REQUIRE_AUTHENTICATED_WS must get 401, got %d", rec.Code)
	}
}

func TestPresenceHandler_MissingJWTWhenAuthEnabled(t *testing.T) {
	hub := NewHub()
	rec := serveGetPresence(
		t,
		"/ws/_presence/_channel_lobby",
		hub,
		false,
		"some-jwt-secret-32-chars-long-xxx",
		"anon-key-12345",
	)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing JWT must get 401, got %d", rec.Code)
	}
}

func decodeContains(t *testing.T, body []byte, needle string) bool {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	for k := range v {
		if k == needle {
			return true
		}
	}
	return false
}
