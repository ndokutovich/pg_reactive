package middleware

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimiter is an in-memory sliding-window rate limiter keyed by client IP.
type RateLimiter struct {
	mu      sync.Mutex
	windows map[string][]time.Time
	maxReqs int
	window  time.Duration
	// TrustedProxies is the list of proxy IPs whose X-Forwarded-For headers
	// are trusted. When empty, the rate limiter uses r.RemoteAddr directly
	// (ignoring X-Forwarded-For entirely) to prevent IP spoofing.
	TrustedProxies []string
}

// NewRateLimiter creates a RateLimiter that allows maxReqs requests per window.
func NewRateLimiter(maxReqs int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		windows: make(map[string][]time.Time),
		maxReqs: maxReqs,
		window:  window,
	}
}

// NewRateLimiterWithProxies creates a RateLimiter with trusted proxy IPs.
func NewRateLimiterWithProxies(maxReqs int, window time.Duration, proxies []string) *RateLimiter {
	return &RateLimiter{
		windows:        make(map[string][]time.Time),
		maxReqs:        maxReqs,
		window:         window,
		TrustedProxies: proxies,
	}
}

// Allow returns true if the IP is within the rate limit, false otherwise.
// It records the current request timestamp for allowed requests.
func (rl *RateLimiter) Allow(ip string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	timestamps := rl.windows[ip]

	// Evict entries outside the sliding window.
	cutoff := now.Add(-rl.window)
	valid := timestamps[:0]
	for _, t := range timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= rl.maxReqs {
		rl.windows[ip] = valid
		return false
	}

	rl.windows[ip] = append(valid, now)
	return true
}

// Middleware returns an http.Handler middleware that rate-limits by real IP.
// Requests exceeding the limit receive 429 Too Many Requests.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := realIP(r, rl.TrustedProxies)
		if !rl.Allow(ip) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			body, _ := json.Marshal(map[string]string{
				"error": "too many requests, try again later",
			})
			_, _ = w.Write(body)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// StartCleanup runs a background goroutine that periodically removes stale IP
// entries whose newest timestamp is older than the rate limit window. The
// goroutine exits when ctx is cancelled.
func (rl *RateLimiter) StartCleanup(ctx context.Context) {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rl.cleanup()
		}
	}
}

// cleanup removes IP entries that have no timestamps within the current window.
func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := time.Now().Add(-rl.window)
	for ip, times := range rl.windows {
		if len(times) == 0 || times[len(times)-1].Before(cutoff) {
			delete(rl.windows, ip)
		}
	}
}

// remoteHost extracts the host (IP) portion from r.RemoteAddr, stripping the port.
func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// realIP extracts the client IP for rate-limiting purposes.
//
// When trustedProxies is empty, X-Forwarded-For is ignored entirely and the
// IP is taken from r.RemoteAddr — prevents header spoofing when there is
// no known reverse proxy in front of the server.
//
// When trustedProxies is set and the immediate hop matches one, we walk
// the X-Forwarded-For list FROM THE RIGHT and return the first IP that is
// NOT itself a trusted proxy. This defeats the
// `$proxy_add_x_forwarded_for` foot-gun (audit F1 round 22): when nginx
// is configured to append, a client-supplied `X-Forwarded-For: 1.2.3.4`
// lands at the LEFT of the resulting chain `1.2.3.4, <real-client-ip>`.
// Taking the leftmost value would honour the spoof; the rightmost-non-
// trusted IP is the last hop the trusted chain attests to.
//
// X-Real-IP is intentionally NOT honoured (audit F1 round 23). The XRI
// single-value form has no chain to attest the source — if a proxy in
// the deployment doesn't explicitly overwrite or drop client-supplied
// XRI, a client can spoof it just as easily as the leftmost XFF value.
// XFF carries the chain explicitly and self-verifies via the trusted-
// proxy walk, so it's the safer canonical source. Operators whose proxy
// only sets XRI must configure it to also set XFF (every mainstream
// reverse proxy supports both).
//
// If every IP in the chain is itself a trusted proxy (or the header is
// empty), fall back to directIP.
func realIP(r *http.Request, trustedProxies []string) string {
	directIP := remoteHost(r)

	if len(trustedProxies) == 0 {
		return directIP
	}

	trustedSet := make(map[string]struct{}, len(trustedProxies))
	for _, tp := range trustedProxies {
		trustedSet[tp] = struct{}{}
	}
	if _, ok := trustedSet[directIP]; !ok {
		// Immediate hop is NOT a trusted proxy — header values are
		// untrustworthy regardless of contents.
		return directIP
	}

	// XFF: walk from right (closest to us) to left (furthest from us),
	// skipping any IPs that are themselves trusted proxies. The first
	// untrusted IP is the real client the chain attests to.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip == "" {
				continue
			}
			if _, isProxy := trustedSet[ip]; isProxy {
				continue
			}
			return ip
		}
	}
	return directIP
}
