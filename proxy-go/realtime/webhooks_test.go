package realtime

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ── matchesEvent ─────────────────────────────────────────────────────────────

func TestMatchesEvent_ExactMatch(t *testing.T) {
	if !matchesEvent([]string{"INSERT", "UPDATE"}, "INSERT") {
		t.Fatal("expected INSERT to match event list containing INSERT")
	}
}

func TestMatchesEvent_ExactMatchUpdate(t *testing.T) {
	if !matchesEvent([]string{"INSERT", "UPDATE"}, "UPDATE") {
		t.Fatal("expected UPDATE to match event list containing UPDATE")
	}
}

func TestMatchesEvent_NoMatch(t *testing.T) {
	if matchesEvent([]string{"INSERT", "UPDATE"}, "DELETE") {
		t.Fatal("expected DELETE not to match event list [INSERT, UPDATE]")
	}
}

func TestMatchesEvent_Wildcard(t *testing.T) {
	if !matchesEvent([]string{"*"}, "DELETE") {
		t.Fatal("expected wildcard '*' to match any event")
	}
	if !matchesEvent([]string{"*"}, "INSERT") {
		t.Fatal("expected wildcard '*' to match INSERT")
	}
}

func TestMatchesEvent_WildcardAmongOthers(t *testing.T) {
	if !matchesEvent([]string{"INSERT", "*"}, "DELETE") {
		t.Fatal("expected wildcard in list to match DELETE")
	}
}

func TestMatchesEvent_CaseInsensitive(t *testing.T) {
	if !matchesEvent([]string{"insert"}, "INSERT") {
		t.Fatal("expected case-insensitive match: 'insert' should match 'INSERT'")
	}
	if !matchesEvent([]string{"INSERT"}, "insert") {
		t.Fatal("expected case-insensitive match: 'INSERT' should match 'insert'")
	}
	if !matchesEvent([]string{"Update"}, "UPDATE") {
		t.Fatal("expected case-insensitive match: 'Update' should match 'UPDATE'")
	}
}

func TestMatchesEvent_EmptyList(t *testing.T) {
	if matchesEvent([]string{}, "INSERT") {
		t.Fatal("expected empty event list to never match")
	}
}

// ── deliverWithRetry ──────────────────────────────────────────────────────────

// newTestWebhookManager builds a WebhookManager that uses a custom HTTP client
// pointing at the provided test server URL.
func newTestWebhookManager(serverURL string) *WebhookManager {
	wm := &WebhookManager{
		client: &http.Client{Timeout: 5 * time.Second},
	}
	return wm
}

func TestDeliverWithRetry_SuccessFirstAttempt(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wm := newTestWebhookManager(srv.URL)
	wh := Webhook{
		ID:     "wh-1",
		URL:    srv.URL,
		Secret: "",
		Active: true,
	}
	wp := WebhookPayload{Event: "INSERT", Table: "orders"}

	wm.deliverWithRetry(wh, wp)

	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected 1 call, got %d", atomic.LoadInt32(&calls))
	}
}

func TestDeliverWithRetry_RetriesOnFailureThenSucceeds(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		// Fail the first two calls, succeed on the third.
		if n < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wm := &WebhookManager{
		client: &http.Client{Timeout: 5 * time.Second},
	}
	wh := Webhook{
		ID:     "wh-retry",
		URL:    srv.URL,
		Secret: "",
		Active: true,
	}
	wp := WebhookPayload{Event: "UPDATE", Table: "items"}

	// Replace the delay slice with zeros so the test runs fast.
	// deliverWithRetry uses package-level delays slice; we call deliver directly
	// to sidestep the sleep while still verifying retry logic.
	// Instead test via deliverWithRetry but accept the sleeps are real —
	// use a counter-based server and verify 3 total calls.
	wm.deliverWithRetry(wh, wp)

	got := atomic.LoadInt32(&calls)
	if got != 3 {
		t.Fatalf("expected exactly 3 calls (2 failures + 1 success), got %d", got)
	}
}

func TestDeliverWithRetry_ExhaustsAllAttempts(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	wm := &WebhookManager{
		client: &http.Client{Timeout: 5 * time.Second},
	}
	wh := Webhook{ID: "wh-fail", URL: srv.URL, Active: true}
	wp := WebhookPayload{Event: "DELETE", Table: "logs"}

	wm.deliverWithRetry(wh, wp)

	got := atomic.LoadInt32(&calls)
	if got != 3 {
		t.Fatalf("expected 3 attempts on total failure, got %d", got)
	}
}

// ── HMAC-SHA256 signature verification ───────────────────────────────────────

func TestDeliver_HMACSignatureFormat(t *testing.T) {
	const secret = "super-secret-key"

	var receivedSig string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedSig = r.Header.Get("X-Webhook-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wm := &WebhookManager{
		client: &http.Client{Timeout: 5 * time.Second},
	}
	wh := Webhook{
		ID:     "wh-sig",
		URL:    srv.URL,
		Secret: secret,
		Active: true,
	}

	wp := WebhookPayload{Event: "INSERT", Table: "orders"}
	body, _ := json.Marshal(wp)

	err := wm.deliver(wh, body)
	if err != nil {
		t.Fatalf("deliver returned error: %v", err)
	}

	// Verify the format is "sha256=<hex>"
	if !strings.HasPrefix(receivedSig, "sha256=") {
		t.Fatalf("X-Webhook-Signature must start with 'sha256=', got: %q", receivedSig)
	}

	hexPart := strings.TrimPrefix(receivedSig, "sha256=")
	if len(hexPart) != 64 {
		t.Fatalf("expected 64-char hex digest (SHA-256), got %d chars: %q", len(hexPart), hexPart)
	}

	// Recompute and confirm the value matches
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if receivedSig != expected {
		t.Fatalf("signature mismatch\n  got:  %s\n  want: %s", receivedSig, expected)
	}
}

func TestDeliver_NoSignatureHeaderWhenSecretEmpty(t *testing.T) {
	var receivedSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedSig = r.Header.Get("X-Webhook-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wm := &WebhookManager{client: &http.Client{Timeout: 5 * time.Second}}
	wh := Webhook{ID: "wh-nosig", URL: srv.URL, Secret: "", Active: true}
	body, _ := json.Marshal(WebhookPayload{Event: "DELETE", Table: "t"})

	if err := wm.deliver(wh, body); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	if receivedSig != "" {
		t.Fatalf("expected no X-Webhook-Signature header when secret is empty, got %q", receivedSig)
	}
}

func TestDeliver_CorrectContentTypeAndUserAgent(t *testing.T) {
	var ct, ua string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct = r.Header.Get("Content-Type")
		ua = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wm := &WebhookManager{client: &http.Client{Timeout: 5 * time.Second}}
	wh := Webhook{ID: "wh-headers", URL: srv.URL, Active: true}
	body, _ := json.Marshal(WebhookPayload{Event: "INSERT", Table: "t"})

	if err := wm.deliver(wh, body); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	if ct != "application/json" {
		t.Errorf("Content-Type: got %q, want %q", ct, "application/json")
	}
	if ua != "pgstack-webhooks/1.0" {
		t.Errorf("User-Agent: got %q, want %q", ua, "pgstack-webhooks/1.0")
	}
}
