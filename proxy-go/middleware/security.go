package middleware

import (
	"net/http"
	"strings"
)

// SecurityHeaders applies strict security headers to every API response.
// This is suitable for all non-studio routes.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Content-Security-Policy", "default-src 'none'")
		next.ServeHTTP(w, r)
	})
}

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
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")

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
