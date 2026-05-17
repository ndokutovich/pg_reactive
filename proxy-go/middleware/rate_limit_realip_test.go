package middleware

// Tests for realIP — round-22 audit F1 fix.
//
// The previous implementation took the LEFTMOST X-Forwarded-For value,
// which is the spoofable end when nginx is configured with the canonical
// `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (append,
// not overwrite). These tests pin the new right-to-left scan that skips
// trusted-proxy hops, plus the X-Real-IP preference.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newReqWithHeaders(remoteAddr string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remoteAddr
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestRealIP_NoTrustedProxies_IgnoresHeaders(t *testing.T) {
	r := newReqWithHeaders("10.0.0.5:1234", map[string]string{
		"X-Forwarded-For": "1.2.3.4",
		"X-Real-IP":       "5.6.7.8",
	})
	if got := realIP(r, nil); got != "10.0.0.5" {
		t.Errorf("realIP w/o trusted proxies = %q, want 10.0.0.5", got)
	}
}

func TestRealIP_UntrustedSource_IgnoresHeaders(t *testing.T) {
	r := newReqWithHeaders("9.9.9.9:1234", map[string]string{
		"X-Forwarded-For": "1.2.3.4",
	})
	if got := realIP(r, []string{"10.0.0.1"}); got != "9.9.9.9" {
		t.Errorf("realIP from untrusted source = %q, want 9.9.9.9 (header ignored)", got)
	}
}

func TestRealIP_PrefersXRealIPOverXFF(t *testing.T) {
	r := newReqWithHeaders("10.0.0.1:1234", map[string]string{
		"X-Forwarded-For": "1.2.3.4",
		"X-Real-IP":       "5.6.7.8",
	})
	if got := realIP(r, []string{"10.0.0.1"}); got != "5.6.7.8" {
		t.Errorf("realIP = %q, want 5.6.7.8 (XRI wins over XFF)", got)
	}
}

// The canonical F1 bypass: nginx appends $proxy_add_x_forwarded_for, so
// a client-supplied X-Forwarded-For: 1.2.3.4 lands LEFT of the real
// client IP in the resulting chain "1.2.3.4, real-client-ip". The OLD
// realIP took position [0] = the spoofed value. The NEW realIP walks
// right to left, skipping trusted-proxy hops, and returns the first
// untrusted IP = real-client-ip.
func TestRealIP_XFFAppendedByNginx_RejectsSpoof(t *testing.T) {
	r := newReqWithHeaders("10.0.0.1:1234", map[string]string{
		// Client sent "X-Forwarded-For: 1.2.3.4" — nginx appended its
		// $remote_addr (203.0.113.99 = the real client) to the right.
		"X-Forwarded-For": "1.2.3.4, 203.0.113.99",
	})
	if got := realIP(r, []string{"10.0.0.1"}); got != "203.0.113.99" {
		t.Errorf("realIP must skip the spoofed leftmost value; got %q, want 203.0.113.99", got)
	}
}

// Multi-hop chain where intermediate hops are themselves trusted
// proxies. We expect realIP to skip them and return the first
// non-trusted IP from the right.
func TestRealIP_SkipsKnownProxyHopsInChain(t *testing.T) {
	r := newReqWithHeaders("10.0.0.1:1234", map[string]string{
		// Chain: client (203.0.113.99) → 10.0.0.2 (trusted) → 10.0.0.1 (direct trusted).
		"X-Forwarded-For": "203.0.113.99, 10.0.0.2",
	})
	trusted := []string{"10.0.0.1", "10.0.0.2"}
	if got := realIP(r, trusted); got != "203.0.113.99" {
		t.Errorf("realIP must skip trusted proxy hops; got %q, want 203.0.113.99", got)
	}
}

// Defensive: if every IP in XFF happens to be trusted (rare config
// quirk), fall back to directIP rather than returning empty.
func TestRealIP_AllHopsTrusted_FallsBackToDirect(t *testing.T) {
	r := newReqWithHeaders("10.0.0.1:1234", map[string]string{
		"X-Forwarded-For": "10.0.0.2, 10.0.0.3",
	})
	trusted := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	if got := realIP(r, trusted); got != "10.0.0.1" {
		t.Errorf("realIP with all-trusted chain = %q, want directIP 10.0.0.1", got)
	}
}

func TestRealIP_EmptyXFF_FallsBackToDirect(t *testing.T) {
	r := newReqWithHeaders("10.0.0.1:1234", nil)
	if got := realIP(r, []string{"10.0.0.1"}); got != "10.0.0.1" {
		t.Errorf("realIP with no XFF/XRI = %q, want directIP 10.0.0.1", got)
	}
}

func TestRealIP_TrustedSourceWithMalformedRemoteAddr(t *testing.T) {
	// remoteHost returns raw RemoteAddr when SplitHostPort fails — the
	// implementation must not panic and must still behave correctly.
	r := newReqWithHeaders("not-a-real-addr", map[string]string{
		"X-Forwarded-For": "1.2.3.4",
	})
	got := realIP(r, []string{"10.0.0.1"})
	if got != "not-a-real-addr" {
		t.Errorf("realIP with malformed RemoteAddr = %q, want raw fallback", got)
	}
}
