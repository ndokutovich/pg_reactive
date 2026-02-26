package middleware

import (
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
}

// NewRateLimiter creates a RateLimiter that allows maxReqs requests per window.
func NewRateLimiter(maxReqs int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		windows: make(map[string][]time.Time),
		maxReqs: maxReqs,
		window:  window,
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
		ip := realIP(r)
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

// realIP extracts the client IP from X-Forwarded-For, X-Real-IP, or RemoteAddr.
func realIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// X-Forwarded-For may be a comma-separated list; take the first (original) IP.
		parts := strings.SplitN(xff, ",", 2)
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
