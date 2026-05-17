package middleware

import (
	"net/http"
	"strings"
)

// SecurityHeaders applies strict security headers to every API response.
// This is suitable for all non-studio routes.
//
// Notes on individual headers:
//   - X-XSS-Protection: 0 disables the legacy IE/Chromium XSS auditor. Modern
//     browsers ignore it, but where supported it has known bypass tricks
//     that can introduce vulnerabilities. Best practice (OWASP) is to set
//     it to 0 explicitly and rely on CSP for XSS defense.
//   - Permissions-Policy: deny-all for the common high-risk surfaces; an
//     API endpoint should never need camera/microphone/geolocation.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-XSS-Protection", "0")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Content-Security-Policy", "default-src 'none'")
		h.Set("Permissions-Policy", apiPermissionsPolicy)
		next.ServeHTTP(w, r)
	})
}

// apiPermissionsPolicy denies every powerful browser feature for API
// endpoints. None of these should ever be requested via a JSON API; an
// explicit denial means a future XSS into a same-origin SPA cannot use the
// API origin as a launchpad to request these capabilities.
const apiPermissionsPolicy = "accelerometer=(), autoplay=(), camera=(), " +
	"clipboard-read=(), clipboard-write=(), display-capture=(), " +
	"encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), " +
	"hid=(), idle-detection=(), magnetometer=(), microphone=(), " +
	"midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), " +
	"screen-wake-lock=(), serial=(), sync-xhr=(), usb=(), web-share=(), " +
	"xr-spatial-tracking=()"

// StudioSecurityHeaders applies the correct security headers depending on
// whether the request is for the Studio SPA or a regular API route.
//
// Studio paths receive a relaxed CSP that permits:
//   - wasm-unsafe-eval  (Vite/WebAssembly)
//   - unsafe-inline styles (CSS-in-JS)
//   - ws:/wss: connections (live queries)
//
// All other paths receive a strict deny-all CSP.
func StudioSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-XSS-Protection", "0")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", apiPermissionsPolicy)

		if strings.HasPrefix(r.URL.Path, "/studio") {
			h.Set("Content-Security-Policy",
				"default-src 'self'; "+
					"script-src 'self' 'wasm-unsafe-eval'; "+
					"style-src 'self' 'unsafe-inline'; "+
					"img-src 'self' data:; "+
					"connect-src 'self' ws: wss:; "+
					"frame-ancestors 'none'",
			)
		} else {
			h.Set("X-Frame-Options", "DENY")
			h.Set("Content-Security-Policy", "default-src 'none'")
		}

		next.ServeHTTP(w, r)
	})
}

// HSTSConfig controls Strict-Transport-Security emission.
//
// Audit round-21 F4+F5: the previous HSTSHeaders middleware trusted
// X-Forwarded-Proto from any source, which lets an attacker who reaches a
// directly-exposed proxy spoof "X-Forwarded-Proto: https" over plaintext
// HTTP and trigger HSTS-preload poisoning (browser remembers the host as
// HTTPS-only for the max-age window). Hardcoded `preload` made that
// poisoning irreversible: hstspreload.org submission is a one-way ticket
// and the host stays HTTPS-only until manual removal months later.
//
// Fix:
//   - TrustedProxies gates XFP acceptance, mirroring rate_limit.realIP.
//     Without trusted proxies configured the middleware honours only
//     r.TLS (direct HTTPS) — XFP is ignored even if present.
//   - Preload is opt-in via HSTS_PRELOAD=true (default false). Operators
//     who want hstspreload.org submission flip the env explicitly,
//     accepting the lock-in.
//   - MaxAge is configurable via HSTS_MAX_AGE_SECONDS (default 63072000 =
//     2 years, the preload submission minimum). Lower it during initial
//     rollout to limit blast radius if TLS breaks.
type HSTSConfig struct {
	TrustedProxies []string
	MaxAge         int  // seconds; 0 → 63072000 default
	Preload        bool // false by default; opt in to hstspreload.org submission
}

// HSTSHeaders returns middleware that sets Strict-Transport-Security on
// responses to requests that demonstrably arrived over TLS.
func HSTSHeaders(cfg HSTSConfig) func(http.Handler) http.Handler {
	maxAge := cfg.MaxAge
	if maxAge <= 0 {
		maxAge = 63072000
	}
	value := "max-age=" + itoa(maxAge) + "; includeSubDomains"
	if cfg.Preload {
		value += "; preload"
	}
	trustedProxies := cfg.TrustedProxies

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isHTTPS(r, trustedProxies) {
				w.Header().Set("Strict-Transport-Security", value)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// isHTTPS reports whether the original client request was over TLS.
// Checks r.TLS (direct HTTPS) and X-Forwarded-Proto, but only honours XFP
// when the immediate connection (r.RemoteAddr) comes from a configured
// trusted proxy — mirrors realIP's trust model. Without trusted proxies
// configured, XFP is ignored entirely to defeat HSTS-preload poisoning
// via spoofed headers against a directly-exposed proxy.
func isHTTPS(r *http.Request, trustedProxies []string) bool {
	if r.TLS != nil {
		return true
	}
	xfp := r.Header.Get("X-Forwarded-Proto")
	if xfp == "" {
		return false
	}
	directIP := remoteHost(r)
	for _, tp := range trustedProxies {
		if directIP == tp {
			return xfp == "https"
		}
	}
	return false
}

// itoa is a tiny stdlib-shaped helper kept local to avoid pulling strconv
// into a hot-path header builder. The HSTS max-age is computed once at
// constructor time, so the cost is one allocation per restart.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// BodyLimit wraps the request body with an http.MaxBytesReader to enforce a
// maximum body size. Requests exceeding the limit will fail during body reads.
func BodyLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}
