package middleware

// Composition tests for the middleware chain — round 25 HIGH regression.
//
// The unit tests in rate_limit_realip_test.go exercise realIP() with
// hand-crafted *http.Request values, so they CANNOT catch a regression
// where an upstream middleware rewrites r.RemoteAddr before realIP sees
// it. The specific class of bug they missed: chi-middleware.RealIP
// (and any similar handler that mutates RemoteAddr from XFF/XRI without
// a trusted-proxy gate) silently neutralises the whole TrustedProxies
// model.
//
// These tests pin the rule that "the request handed to a security
// middleware must carry the AUTHENTIC immediate-connection IP". They
// run a chi-style chain over an httptest.Server so we can see the
// real RemoteAddr the kernel reports.

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
)

// captureRemoteAddrHandler echoes the remoteHost(r) as plain text so the
// test can assert what the rate limiter would have seen.
func captureRemoteAddrHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, remoteHost(r))
	}
}

// hitWithSpoofedHeaders dials the test server directly (so the kernel-
// observed remote addr is 127.0.0.1) but sends X-Real-IP / X-Forwarded-For
// values that claim to be a different IP — exactly the bypass attempt the
// trusted-proxy model is supposed to refuse.
func hitWithSpoofedHeaders(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/", nil)
	if err != nil {
		t.Fatalf("build req: %v", err)
	}
	req.Header.Set("X-Real-IP", "1.2.3.4")
	req.Header.Set("X-Forwarded-For", "5.6.7.8, 9.10.11.12")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do req: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(body))
}

// Pin: the chain pgStack uses must NOT pre-mutate RemoteAddr. The handler
// must see the kernel-attested 127.0.0.1 (httptest.Server's loopback), not
// the spoofed XRI / XFF value.
func TestMiddlewareChain_PreservesAuthenticRemoteAddr(t *testing.T) {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	// NO chiMiddleware.RealIP here — same as production main.go after F1 fix.
	r.Get("/", captureRemoteAddrHandler())

	srv := httptest.NewServer(r)
	defer srv.Close()

	got := hitWithSpoofedHeaders(t, srv)
	host, _, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatalf("parse srv url: %v", err)
	}
	if got != host {
		t.Fatalf("handler saw RemoteAddr = %q, want kernel-attested %q — security middleware would be looking at a spoofed IP", got, host)
	}
}

// Negative pin: chi's RealIP middleware DOES rewrite RemoteAddr from the
// spoofed headers. This test documents WHY we removed it — without this
// regression test, anyone re-adding chi.RealIP "for convenience" would
// silently re-introduce the high-severity bypass and unit tests would
// stay green.
func TestMiddlewareChain_ChiRealIPRewritesAndBypassesGate(t *testing.T) {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(chiMiddleware.RealIP) // intentionally re-added to prove the bypass
	r.Get("/", captureRemoteAddrHandler())

	srv := httptest.NewServer(r)
	defer srv.Close()

	got := hitWithSpoofedHeaders(t, srv)
	host, _, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if got == host {
		t.Fatal("chi.RealIP behaviour changed upstream — this test was meant to document that it DOES rewrite RemoteAddr from spoofed headers. Either upstream fixed it (then we can re-enable) or our test setup is wrong.")
	}
	// The exact rewritten value can be X-Real-IP (1.2.3.4) or first XFF
	// entry (5.6.7.8) depending on chi's preference order. Either way it
	// must NOT equal the kernel-attested loopback.
	if got != "1.2.3.4" && got != "5.6.7.8" {
		t.Fatalf("unexpected chi.RealIP rewrite target %q (want 1.2.3.4 or 5.6.7.8)", got)
	}
}

// Same composition pin from the realIP perspective: with chi.RealIP gone,
// our own realIP() called from inside a handler returns the kernel-attested
// IP even when XFF/XRI are populated and no proxies are trusted.
func TestMiddlewareChain_RealIPHelperSeesAuthenticAddr(t *testing.T) {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, realIP(req, nil))
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	got := hitWithSpoofedHeaders(t, srv)
	host, _, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if got != host {
		t.Fatalf("realIP() returned %q, want %q — XFF/XRI spoof was honoured", got, host)
	}
}
