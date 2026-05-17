package auth

// requireServiceRole regression tests — round 24 hardening.
//
// The previous implementation relied on the production validator refusing
// to start with empty SERVICE_ROLE_KEY AND on Go's net/http trimming
// trailing whitespace from header values. Both true today, but a defence
// in depth empty-key guard makes the function robust to:
//   - dev / test deployments that boot without PGSTACK_ENV=production,
//   - future HTTP parser quirks that might let "Bearer " survive intact,
//   - direct callers (test harness, internal tooling) that bypass net/http.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireServiceRole_EmptyKeyAlwaysRejected(t *testing.T) {
	// Empty key + empty Bearer → 403. The pre-round-24 behaviour would
	// have invoked constantTimeEqual("","") which returns true; the new
	// empty-key short-circuit refuses unconditionally.
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/admin", nil)
	r.Header.Set("Authorization", "Bearer ")

	if requireServiceRole(rec, r, "") {
		t.Fatal("requireServiceRole must refuse with empty SERVICE_ROLE_KEY, but returned true")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestRequireServiceRole_EmptyKeyAndMatchingEmptyBearer(t *testing.T) {
	// Direct test of the underlying constant-time-equal would pass for
	// ("",""). The wrapper must refuse anyway.
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/admin", nil)
	// No Authorization header at all — the missing-header branch also
	// refuses, but the empty-key guard fires first.
	if requireServiceRole(rec, r, "") {
		t.Fatal("empty key + missing header must refuse")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestRequireServiceRole_RealKeyValidBearer(t *testing.T) {
	const key = "sr-key-32-chars-real-secret-xxx"
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/admin", nil)
	r.Header.Set("Authorization", "Bearer "+key)

	if !requireServiceRole(rec, r, key) {
		t.Fatalf("valid bearer must succeed; status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRequireServiceRole_RealKeyWrongBearer(t *testing.T) {
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/admin", nil)
	r.Header.Set("Authorization", "Bearer not-the-real-key")
	if requireServiceRole(rec, r, "sr-key-32-chars-real-secret-xxx") {
		t.Fatal("wrong bearer must be refused")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

func TestRequireServiceRole_RealKeyMissingHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/admin", nil)
	if requireServiceRole(rec, r, "sr-key-32-chars-real-secret-xxx") {
		t.Fatal("missing Authorization must be refused")
	}
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}
