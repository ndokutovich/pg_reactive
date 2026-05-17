package middleware

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func runHandler(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func TestSecurityHeaders_SetsStrictAPIPolicy(t *testing.T) {
	rec := runHandler(SecurityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})),
		httptest.NewRequest(http.MethodGet, "/health", nil))

	want := map[string]string{
		"X-Content-Type-Options":  "nosniff",
		"X-Frame-Options":         "DENY",
		"X-XSS-Protection":        "0",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
		"Content-Security-Policy": "default-src 'none'",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("SecurityHeaders[%s] = %q, want %q", k, got, v)
		}
	}
	if rec.Header().Get("Permissions-Policy") == "" {
		t.Error("SecurityHeaders missing Permissions-Policy")
	}
}

func TestPublicSecurityHeaders_BlockWorldDefaults(t *testing.T) {
	mw := PublicSecurityHeaders(false)
	rec := runHandler(mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})),
		httptest.NewRequest(http.MethodGet, "/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	requiredDirectives := []string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self' ws: wss:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}
	for _, d := range requiredDirectives {
		if !strings.Contains(csp, d) {
			t.Errorf("CSP missing directive %q\nfull CSP: %s", d, csp)
		}
	}
	// script-src must NOT contain unsafe-inline by default
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Error("default PublicSecurityHeaders must not allow unsafe-inline in script-src")
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q, want DENY", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
		t.Errorf("Referrer-Policy = %q", got)
	}
}

func TestPublicSecurityHeaders_AllowInlineScripts(t *testing.T) {
	mw := PublicSecurityHeaders(true)
	rec := runHandler(mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})),
		httptest.NewRequest(http.MethodGet, "/", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("allowInlineScripts=true should permit unsafe-inline; got CSP: %s", csp)
	}
}

func TestPublicSecurityHeaders_CSPPolicyEnvOverride(t *testing.T) {
	const override = "default-src https://example.com; script-src 'self'"
	t.Setenv("CSP_POLICY", override)

	mw := PublicSecurityHeaders(false)
	rec := runHandler(mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})),
		httptest.NewRequest(http.MethodGet, "/", nil))

	if got := rec.Header().Get("Content-Security-Policy"); got != override {
		t.Errorf("CSP_POLICY override not applied: got %q, want %q", got, override)
	}
}

// hstsMiddleware builds the middleware for the given config and wraps a
// no-op handler — every test only inspects response headers.
func hstsMiddleware(cfg HSTSConfig) http.Handler {
	return HSTSHeaders(cfg)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
}

func TestHSTSHeaders_SkipsPlainHTTP(t *testing.T) {
	rec := runHandler(hstsMiddleware(HSTSConfig{}),
		httptest.NewRequest(http.MethodGet, "/", nil))
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("plain HTTP must not get HSTS; got %q", got)
	}
}

func TestHSTSHeaders_FiresOnDirectTLS(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.TLS = &tls.ConnectionState{}
	rec := runHandler(hstsMiddleware(HSTSConfig{Preload: true}), r)
	got := rec.Header().Get("Strict-Transport-Security")
	if !strings.Contains(got, "max-age=63072000") || !strings.Contains(got, "includeSubDomains") || !strings.Contains(got, "preload") {
		t.Errorf("HSTS missing required tokens for preload list: %q", got)
	}
}

// Round-21 F4: XFP from an UNTRUSTED source must NOT trigger HSTS.
// Without this gate an attacker reaching a directly-exposed proxy could
// spoof XFP:https and poison browsers with HSTS preload.
func TestHSTSHeaders_IgnoresXFPFromUntrustedSource(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	// No TrustedProxies configured AND RemoteAddr is httptest's default
	// (192.0.2.1) — XFP must be ignored.
	rec := runHandler(hstsMiddleware(HSTSConfig{}), r)
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("XFP from untrusted source must NOT trigger HSTS; got %q", got)
	}
}

func TestHSTSHeaders_FiresOnXForwardedProtoHTTPSFromTrustedProxy(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-Proto", "https")
	rec := runHandler(hstsMiddleware(HSTSConfig{TrustedProxies: []string{"10.0.0.1"}}), r)
	if rec.Header().Get("Strict-Transport-Security") == "" {
		t.Error("HSTS must fire when X-Forwarded-Proto=https from a trusted proxy")
	}
}

func TestHSTSHeaders_SkipsXForwardedProtoHTTP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.1:443"
	r.Header.Set("X-Forwarded-Proto", "http")
	rec := runHandler(hstsMiddleware(HSTSConfig{TrustedProxies: []string{"10.0.0.1"}}), r)
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("X-Forwarded-Proto=http must not set HSTS; got %q", got)
	}
}

// Round-21 F5: preload is opt-in. Default config must NOT include it,
// because hstspreload.org submission is irreversible.
func TestHSTSHeaders_PreloadOptIn(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.TLS = &tls.ConnectionState{}
	rec := runHandler(hstsMiddleware(HSTSConfig{}), r)
	got := rec.Header().Get("Strict-Transport-Security")
	if strings.Contains(got, "preload") {
		t.Errorf("default HSTS must NOT include preload; got %q", got)
	}
	if got == "" || !strings.Contains(got, "max-age=") {
		t.Errorf("HSTS should still fire on direct TLS without preload; got %q", got)
	}
}

func TestHSTSHeaders_CustomMaxAge(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.TLS = &tls.ConnectionState{}
	rec := runHandler(hstsMiddleware(HSTSConfig{MaxAge: 300}), r)
	got := rec.Header().Get("Strict-Transport-Security")
	if !strings.Contains(got, "max-age=300") {
		t.Errorf("expected max-age=300 to override default; got %q", got)
	}
}
