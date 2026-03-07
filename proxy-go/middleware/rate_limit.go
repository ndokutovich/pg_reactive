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

// realIP extracts the client IP for rate limiting purposes.
//
// When trustedProxies is empty, X-Forwarded-For is ignored entirely and the IP
// is taken directly from r.RemoteAddr. This prevents IP spoofing via forged
// headers when there is no known reverse proxy in front of the server.
//
// When trustedProxies is set, X-Forwarded-For and X-Real-IP are only trusted
// if the immediate connection (r.RemoteAddr) comes from one of the listed
// proxy IPs.
func realIP(r *http.Request, trustedProxies []string) string {
	directIP := remoteHost(r)

	if len(trustedProxies) == 0 {
		// No trusted proxies configured: use the direct connection IP only.
		return directIP
	}

	// Check whether the direct connection is from a trusted proxy.
	trusted := false
	for _, tp := range trustedProxies {
		if directIP == tp {
			trusted = true
			break
		}
	}
	if !trusted {
		return directIP
	}

	// Connection is from a trusted proxy: honour forwarded headers.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	return directIP
}
