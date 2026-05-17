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

// HSTSHeaders adds the Strict-Transport-Security header to every response
// reaching the client over HTTPS. Per-request gate (not startup-time) so the
// header still fires when this proxy runs HTTP behind a TLS-terminating
// reverse proxy (umbrella nginx, Cloudflare, etc.) — those forward the
// original scheme in X-Forwarded-Proto.
//
// Sending HSTS over plain HTTP is meaningless (browsers ignore it) and can
// poison clients if the deployment ever needs to roll back to HTTP, so the
// guard matters.
//
// Policy: 2 years + includeSubDomains + preload — meets the hstspreload.org
// submission requirements.
func HSTSHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isHTTPS(r) {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		}
		next.ServeHTTP(w, r)
	})
}

// isHTTPS reports whether the original client request was over TLS.
// Checks r.TLS (direct HTTPS) and X-Forwarded-Proto (behind a TLS-terminating
// reverse proxy). Requires that RealIP/proxy-trust middleware runs first so
// X-Forwarded-Proto is trustworthy.
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if r.Header.Get("X-Forwarded-Proto") == "https" {
		return true
	}
	return false
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
