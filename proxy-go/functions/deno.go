package functions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/rs/zerolog/log"

	"pgstack-proxy-go/rest"
)

// denoHealthTimeout / denoHealthClient bound the edge-runtime health probe.
// http.DefaultClient has no timeout, so a Deno container that accepts the
// connection but never responds would block the handler goroutine indefinitely —
// a slow-loris DoS that leaks goroutines and connection slots (gemini audit P2).
// A health check must be fast; 5s is generous. The bound is applied as a request
// context deadline (denoHealthTimeout is a var so tests can shorten it). The
// function-invoke reverse proxy is deliberately NOT bounded this way — it streams
// and is tied to the client request context so long-running functions survive.
var (
	denoHealthTimeout = 5 * time.Second
	denoHealthClient  = &http.Client{}
)

// proxyToDeno forwards the request to the Deno edge-runtime container
// with auth context injected as headers. The edge-runtime expects requests
// at /functions/v1/{name} and reads pgstack identity from x-pgstack-*
// headers to apply RLS in user-land functions.
func proxyToDeno(d *FunctionsDeps, w http.ResponseWriter, r *http.Request, fnName string, claims *rest.RequestClaims) {
	if d.EdgeRuntimeURL == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "Deno runtime not configured (set EDGE_RUNTIME_URL)")
		return
	}

	target, err := url.Parse(d.EdgeRuntimeURL)
	if err != nil {
		log.Error().Err(err).Str("url", d.EdgeRuntimeURL).Msg("functions: invalid EDGE_RUNTIME_URL")
		writeJSONError(w, http.StatusInternalServerError, "edge runtime configuration error")
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	// Override the default error handler to return structured JSON on proxy
	// failures (e.g. edge-runtime container down).
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		log.Error().Err(proxyErr).Str("fn", fnName).Msg("functions: deno proxy error")
		writeJSONError(rw, http.StatusBadGateway, "edge runtime unreachable")
	}

	// Rewrite the request path to match edge-runtime expectations:
	// POST /functions/v1/{name} on the edge-runtime container.
	r.URL.Path = "/functions/v1/" + fnName
	r.URL.Host = target.Host
	r.URL.Scheme = target.Scheme
	r.Host = target.Host

	// Inject auth context headers so the Deno function can read the caller's
	// identity without re-validating the JWT. Shared with the "http" runtime.
	injectAuthHeaders(r, claims)

	log.Debug().
		Str("fn", fnName).
		Str("target", target.String()).
		Str("role", claims.Role).
		Msg("functions: proxying to Deno edge-runtime")

	proxy.ServeHTTP(w, r)
}

// DenoHealth returns an http.HandlerFunc that proxies to the edge-runtime
// health endpoint. Useful for readiness checks when the Deno runtime is
// enabled. Returns 503 with a JSON error if EDGE_RUNTIME_URL is not set.
func DenoHealth(d *FunctionsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.EdgeRuntimeURL == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "Deno runtime not configured")
			return
		}

		target, err := url.Parse(d.EdgeRuntimeURL)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "edge runtime configuration error")
			return
		}

		// Build a simple GET to the edge-runtime root (health check), bounded by
		// a deadline so a hung edge-runtime cannot wedge the goroutine.
		ctx, cancel := context.WithTimeout(r.Context(), denoHealthTimeout)
		defer cancel()
		healthReq, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "failed to create health request")
			return
		}

		resp, err := denoHealthClient.Do(healthReq)
		if err != nil {
			log.Warn().Err(err).Msg("functions: deno health check failed")
			writeJSONError(w, http.StatusBadGateway, "edge runtime unreachable")
			return
		}
		defer resp.Body.Close()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deno_runtime": "ok",
			"status_code":  resp.StatusCode,
		})
	}
}
