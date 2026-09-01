package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseSidecarRoutes_Empty(t *testing.T) {
	got, err := ParseSidecarRoutes("")
	if err != nil {
		t.Fatalf("empty: %v", err)
	}
	if got != nil {
		t.Errorf("empty should yield no routes, got %v", got)
	}
}

func TestParseSidecarRoutes_ParsesAndKeepsOrder(t *testing.T) {
	got, err := ParseSidecarRoutes("/coop=http://127.0.0.1:8787, /jobs=http://localhost:9000")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("routes = %d, want 2", len(got))
	}
	if got[0].Prefix != "/coop" || got[0].Upstream.Host != "127.0.0.1:8787" {
		t.Errorf("route 0 = %+v", got[0])
	}
	if got[1].Prefix != "/jobs" || got[1].Upstream.Host != "localhost:9000" {
		t.Errorf("route 1 = %+v", got[1])
	}
}

// The one that matters. Forwarding is unauthenticated, so a routable upstream
// would make the proxy fetch arbitrary hosts on request — an open relay one
// config typo away.
func TestParseSidecarRoutes_RefusesNonLoopback(t *testing.T) {
	for _, raw := range []string{
		"/x=http://10.0.0.5:8787",
		"/x=http://example.com:80",
		"/x=http://169.254.169.254/latest/meta-data",   // cloud metadata: the classic SSRF target
		"/x=http://[::ffff:169.254.169.254]:80",        // same address wearing IPv6
	} {
		if _, err := ParseSidecarRoutes(raw); err == nil {
			t.Errorf("%q was accepted; a non-loopback upstream must be refused", raw)
		}
	}
}

func TestParseSidecarRoutes_RefusesPlatformPrefixes(t *testing.T) {
	for _, raw := range []string{
		"/auth=http://127.0.0.1:9000",
		"/auth/v1=http://127.0.0.1:9000",
		"/rest=http://127.0.0.1:9000",
		"/storage/v1=http://127.0.0.1:9000",
	} {
		if _, err := ParseSidecarRoutes(raw); err == nil {
			t.Errorf("%q was accepted; it shadows the platform's own surface with something unauthenticated", raw)
		}
	}
}

func TestParseSidecarRoutes_RefusesMalformed(t *testing.T) {
	for _, raw := range []string{
		"/coop",                            // no upstream
		"coop=http://127.0.0.1:8787",       // prefix is not a path
		"/coop=https://127.0.0.1:8787",     // this hop never leaves the host
		"/coop=http://",                    // no host
		"/a=http://127.0.0.1:1,/a=http://127.0.0.1:2", // same prefix twice
	} {
		if _, err := ParseSidecarRoutes(raw); err == nil {
			t.Errorf("%q was accepted, want an error", raw)
		}
	}
}

// The prefix reaches the sidecar unstripped, so the same URL works whether the
// request came through this proxy or through an outer one pointed straight at
// the sidecar's port. Stripping would make the two deployments disagree.
func TestSidecarRoute_ForwardsFullPath(t *testing.T) {
	var seen string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	routes, err := ParseSidecarRoutes("/coop=" + strings.Replace(upstream.URL, "localhost", "127.0.0.1", 1))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	rec := httptest.NewRecorder()
	routes[0].Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/coop/room/7", nil))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if seen != "/coop/room/7" {
		t.Errorf("sidecar saw %q, want /coop/room/7", seen)
	}
}
