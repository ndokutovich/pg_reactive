package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newCORSReq(origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func run(mw func(http.Handler) http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(rec, r)
	return rec
}

func TestCORS_StrictMode_NoAllowOrigin(t *testing.T) {
	mw := CORSMiddleware(nil, false)
	rec := run(mw, newCORSReq("https://evil.example"))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("strict mode must not set Allow-Origin, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("strict mode must not set Allow-Credentials, got %q", got)
	}
}

func TestCORS_PermissiveMode_ReflectsOrigin(t *testing.T) {
	mw := CORSMiddleware(nil, true)
	rec := run(mw, newCORSReq("https://dev.example"))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://dev.example" {
		t.Fatalf("permissive must reflect origin, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("permissive must set credentials, got %q", got)
	}
}

func TestCORS_AllowlistMode_AllowsListed(t *testing.T) {
	mw := CORSMiddleware([]string{"https://app.example"}, false)
	rec := run(mw, newCORSReq("https://app.example"))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("listed origin should be allowed, got %q", got)
	}
}

func TestCORS_AllowlistMode_RejectsUnlisted(t *testing.T) {
	mw := CORSMiddleware([]string{"https://app.example"}, false)
	rec := run(mw, newCORSReq("https://evil.example"))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unlisted origin must not get Allow-Origin, got %q", got)
	}
}

func TestCORS_AllowlistMode_PermissiveFlagIgnored(t *testing.T) {
	// allowPermissive must NOT widen an explicit allow-list; it only matters when
	// the list is empty.
	mw := CORSMiddleware([]string{"https://app.example"}, true)
	rec := run(mw, newCORSReq("https://evil.example"))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("allow-list with permissive must still reject unlisted, got %q", got)
	}
}
