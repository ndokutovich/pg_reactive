package realtime

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsPublicUnicast(t *testing.T) {
	allowed := []string{
		"1.1.1.1", "8.8.8.8", "203.0.113.5",
		"2606:4700:4700::1111", // Cloudflare DNS over IPv6
	}
	blocked := []string{
		"0.0.0.0",                   // unspecified
		"127.0.0.1", "127.5.5.5",   // loopback
		"169.254.169.254",          // AWS / GCP / Azure metadata
		"169.254.1.1",              // link-local
		"10.0.0.1", "172.16.0.5",   // RFC 1918
		"192.168.1.1",
		"100.64.0.1",               // RFC 6598 carrier-grade NAT
		"224.0.0.1",                // multicast
		"255.255.255.255",          // broadcast
		"::1",                       // IPv6 loopback
		"fe80::1",                   // IPv6 link-local
		"fc00::1",                   // IPv6 ULA (private)
	}

	for _, raw := range allowed {
		ip := net.ParseIP(raw)
		if !isPublicUnicast(ip) {
			t.Errorf("isPublicUnicast(%s) = false, want true", raw)
		}
	}
	for _, raw := range blocked {
		ip := net.ParseIP(raw)
		if isPublicUnicast(ip) {
			t.Errorf("isPublicUnicast(%s) = true, want false", raw)
		}
	}
}

// httptest spins up on 127.0.0.1, so the DialContext guard MUST refuse
// the connection when we try to POST to it via our hardened client.
func TestWebhookClient_RefusesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	c := newWebhookHTTPClient()
	resp, err := c.Get(srv.URL)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected refusal for loopback target, got success")
	}
	if !strings.Contains(err.Error(), "non-public IP") {
		t.Fatalf("expected non-public-IP refusal, got: %v", err)
	}
}

// Run a tiny redirect server on a non-loopback path? We can't — httptest
// only listens on 127.0.0.1, and the loopback guard fires before the
// CheckRedirect callback runs. The redirect policy is still exercised
// indirectly via TestWebhookClient_CheckRedirectReturnsSentinel below.
func TestWebhookClient_CheckRedirectReturnsSentinel(t *testing.T) {
	c := newWebhookHTTPClient()
	// Invoke CheckRedirect directly with a synthetic chain — it must
	// reject every redirect attempt.
	err := c.CheckRedirect(nil, []*http.Request{nil})
	if !errors.Is(err, errRedirectsBlocked) {
		t.Fatalf("CheckRedirect must return errRedirectsBlocked, got %v", err)
	}
}

func TestWebhookDialerWouldAllow(t *testing.T) {
	if err := webhookDialerWouldAllow(nil, "1.1.1.1"); err != nil {
		t.Fatalf("public IPv4 should be allowed: %v", err)
	}
	if err := webhookDialerWouldAllow(nil, "127.0.0.1"); err == nil {
		t.Fatal("loopback IP must be refused")
	}
	if err := webhookDialerWouldAllow(nil, "169.254.169.254"); err == nil {
		t.Fatal("metadata IP must be refused")
	}
}

// Silence the unused-import linter — io is only used when expanding the
// test suite to read response bodies; keep it imported for future tests.
var _ = io.ReadAll
