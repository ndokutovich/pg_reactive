package functions

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/rest"
)

// runtime="http" — polyglot edge functions.
//
// The pre-existing "deno" runtime is, under the hood, a generic HTTP reverse
// proxy that injects the caller's identity as X-Pgstack-* headers; its only
// limitation is the single global EDGE_RUNTIME_URL. The "http" runtime lifts
// that: each function row carries its own upstream_url, so a function can be
// a container in ANY language sitting on the docker network. proxyToUpstream
// is wire-compatible with proxyToDeno — a container written for one runtime
// works behind the other.

// sharedUpstreamTransport is reused across every per-function reverse proxy.
// One long-lived Transport (connection pooling, bounded timeouts) rather than
// one per request — the conventional Go pattern, mirroring realtime/webhooks.go.
var sharedUpstreamTransport = &http.Transport{
	DialContext: (&net.Dialer{
		Timeout:   3 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   10,
	IdleConnTimeout:       90 * time.Second,
	ResponseHeaderTimeout: 30 * time.Second,
}

// httpProxyCache holds one *httputil.ReverseProxy per distinct upstream URL,
// shared across functions that target the same upstream. Rebuilt on every
// catalog Refresh so deleted/changed/deactivated upstreams are dropped.
type httpProxyCache struct {
	mu      sync.RWMutex
	proxies map[string]*httputil.ReverseProxy
}

var fnProxyCache = &httpProxyCache{proxies: map[string]*httputil.ReverseProxy{}}

// validateUpstreamURL enforces the SSRF policy for runtime="http" upstreams.
//
// The deployment model is "the function is a sibling container on the docker
// network", so the safe, zero-config default is: http(s) scheme only, and the
// host must be a BARE docker-network hostname — no IP literals (which blocks
// loopback, link-local, and the cloud metadata endpoint 169.254.169.254) and
// no dotted FQDNs (which keeps a function from being pointed at an arbitrary
// public host). Operators who genuinely need an external FQDN can widen this
// — but ship strict.
func validateUpstreamURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, fmt.Errorf("upstream_url is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream_url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("upstream_url scheme must be http or https, got %q", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("upstream_url has no host")
	}
	if ip := net.ParseIP(host); ip != nil {
		return nil, fmt.Errorf("upstream_url host must be a docker-network hostname, not an IP literal (%s)", host)
	}
	if strings.Contains(host, ".") {
		return nil, fmt.Errorf("upstream_url host must be a bare docker-network hostname, not a dotted name (%s)", host)
	}
	return u, nil
}

// rebuildHTTPProxies is called by FunctionsCatalog.Refresh after the metadata
// map is swapped. It constructs a fresh proxy map for the currently-active
// http-runtime upstreams and swaps it in under the write lock. No new
// goroutine, no new LISTEN — it rides the catalog's existing NOTIFY-driven
// refresh.
func rebuildHTTPProxies(funcs map[string]*FunctionMeta) {
	next := make(map[string]*httputil.ReverseProxy)
	for _, fm := range funcs {
		if fm.Runtime != "http" {
			continue
		}
		if _, exists := next[fm.UpstreamURL]; exists {
			continue // several functions may share one upstream
		}
		target, err := validateUpstreamURL(fm.UpstreamURL)
		if err != nil {
			// Refresh already drops invalid rows before they reach here;
			// guard anyway so a future caller can't slip one through.
			log.Warn().Err(err).Str("fn", fm.Name).Str("upstream", fm.UpstreamURL).
				Msg("functions: skipping http upstream that failed validation")
			continue
		}
		next[fm.UpstreamURL] = newUpstreamProxy(target)
	}
	fnProxyCache.mu.Lock()
	fnProxyCache.proxies = next
	fnProxyCache.mu.Unlock()
}

func newUpstreamProxy(target *url.URL) *httputil.ReverseProxy {
	p := httputil.NewSingleHostReverseProxy(target)
	p.Transport = sharedUpstreamTransport
	p.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		log.Error().Err(proxyErr).Str("upstream", target.String()).
			Msg("functions: http upstream unreachable")
		writeJSONError(rw, http.StatusBadGateway, "function upstream unreachable")
	}
	return p
}

func (c *httpProxyCache) get(upstream string) *httputil.ReverseProxy {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.proxies[upstream]
}

// proxyToUpstream forwards the request to the function's own upstream
// container, with caller identity injected as X-Pgstack-* headers. The path
// rewrite matches proxyToDeno exactly, so the "http" and "deno" runtimes are
// wire-compatible.
func proxyToUpstream(w http.ResponseWriter, r *http.Request, fm *FunctionMeta, claims *rest.RequestClaims) {
	proxy := fnProxyCache.get(fm.UpstreamURL)
	if proxy == nil {
		// Catalog and proxy cache are rebuilt together under Refresh, so this
		// is only reachable in a brief race or if validation dropped the row.
		log.Error().Str("fn", fm.Name).Str("upstream", fm.UpstreamURL).
			Msg("functions: no reverse proxy for http function upstream")
		writeJSONError(w, http.StatusBadGateway, "function upstream not available")
		return
	}

	target, err := url.Parse(fm.UpstreamURL)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "edge function configuration error")
		return
	}

	// Rewrite to the upstream's expected path — identical to proxyToDeno.
	r.URL.Path = "/functions/v1/" + fm.Name
	r.URL.Host = target.Host
	r.URL.Scheme = target.Scheme
	r.Host = target.Host

	injectAuthHeaders(r, claims)

	// Per-request deadline as a backstop on top of the Transport timeouts.
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	log.Debug().
		Str("fn", fm.Name).
		Str("upstream", target.String()).
		Str("role", claims.Role).
		Msg("functions: proxying to http upstream")

	proxy.ServeHTTP(w, r.WithContext(ctx))
}

// injectAuthHeaders sets the X-Pgstack-* identity headers on an outbound
// proxied request. Inbound copies are stripped first so a client cannot
// smuggle a forged role/sub/claims past the proxy. Shared by the "deno" and
// "http" runtimes.
func injectAuthHeaders(r *http.Request, claims *rest.RequestClaims) {
	r.Header.Del("X-Pgstack-Role")
	r.Header.Del("X-Pgstack-Sub")
	r.Header.Del("X-Pgstack-Claims")
	r.Header.Set("X-Pgstack-Role", claims.Role)
	r.Header.Set("X-Pgstack-Sub", claims.Sub)
	if claims.ClaimsJSON != "" {
		r.Header.Set("X-Pgstack-Claims", claims.ClaimsJSON)
	}
}
