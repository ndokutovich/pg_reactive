package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// SidecarRoute forwards one path prefix to another process in the same
// deployment. The platform never learns what lives there — the deployment says
// so with SIDECAR_ROUTES, and the proxy only carries bytes.
type SidecarRoute struct {
	Prefix   string   // "/coop", always leading-slash, never trailing
	Upstream *url.URL // "http://127.0.0.1:8787"
}

// ParseSidecarRoutes reads `prefix=upstream[,prefix=upstream…]`.
//
// The upstream must resolve to loopback. This forwards without authenticating
// anything, so pointing it at a routable host would quietly turn the proxy into
// an open relay for whatever is there — a config typo away from a proxy that
// fetches arbitrary internal URLs on request.
func ParseSidecarRoutes(raw string) ([]SidecarRoute, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var out []SidecarRoute
	seen := map[string]bool{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		prefix, upstream, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, fmt.Errorf("%q is not prefix=upstream", entry)
		}
		prefix = strings.TrimRight(strings.TrimSpace(prefix), "/")
		upstream = strings.TrimSpace(upstream)

		if !strings.HasPrefix(prefix, "/") || prefix == "" {
			return nil, fmt.Errorf("prefix %q must start with / and name a path", prefix)
		}
		// Reserved trees. A route over /auth or /rest would shadow the
		// platform's own surface with something unauthenticated.
		for _, reserved := range []string{"/auth", "/rest", "/realtime", "/storage", "/functions", "/studio", "/docs", "/health"} {
			if prefix == reserved || strings.HasPrefix(prefix+"/", reserved+"/") {
				return nil, fmt.Errorf("prefix %q shadows the platform's own %s", prefix, reserved)
			}
		}
		if seen[prefix] {
			return nil, fmt.Errorf("prefix %q appears twice", prefix)
		}
		seen[prefix] = true

		u, err := url.Parse(upstream)
		if err != nil {
			return nil, fmt.Errorf("upstream %q: %w", upstream, err)
		}
		if u.Scheme != "http" {
			return nil, fmt.Errorf("upstream %q must be http:// — this hop never leaves the host", upstream)
		}
		host := u.Hostname()
		if host == "" {
			return nil, fmt.Errorf("upstream %q has no host", upstream)
		}
		if host != "localhost" {
			ip := net.ParseIP(host)
			if ip == nil || !ip.IsLoopback() {
				return nil, fmt.Errorf("upstream %q must be loopback (127.0.0.1, ::1, localhost) — forwarding is unauthenticated", upstream)
			}
		}

		out = append(out, SidecarRoute{Prefix: prefix, Upstream: u})
	}
	return out, nil
}

// Handler is a reverse proxy to the sidecar. WebSocket upgrades pass through:
// httputil.ReverseProxy hands back the 101 and hijacks the connection, which is
// usually the whole reason a deployment has a sidecar in the first place.
//
// The prefix is NOT stripped. A sidecar that owns /coop should listen on /coop,
// so the same URL works whether the request arrived through this proxy or
// through an outer one that routes the prefix straight to the sidecar's port.
// Stripping here would make those two deployments disagree about the path.
func (s SidecarRoute) Handler() http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(s.Upstream)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		// NewSingleHostReverseProxy joins the target path with the request
		// path; the target has none, so the request path survives intact.
		r.Host = s.Upstream.Host
	}
	return proxy
}
