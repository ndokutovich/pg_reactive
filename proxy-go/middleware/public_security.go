package middleware

import "net/http"

// PublicSecurityHeaders returns middleware that applies security headers for
// user-facing SPAs served from the public/ directory. More permissive than
// API SecurityHeaders but still enforces frame protection and content-type
// sniffing prevention.
//
// allowInlineScripts adds 'unsafe-inline' to the script-src CSP directive —
// off by default (strict). Enable it only for static apps that rely on inline
// <script> blocks (e.g. the pg_reactive examples); a modern bundled SPA keeps
// all scripts external and should leave it off.
func PublicSecurityHeaders(allowInlineScripts bool) func(http.Handler) http.Handler {
	scriptSrc := "script-src 'self'"
	if allowInlineScripts {
		scriptSrc = "script-src 'self' 'unsafe-inline'"
	}
	csp := "default-src 'self'; " +
		scriptSrc + "; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		"font-src 'self' data:; " +
		"connect-src 'self' ws: wss:; " +
		"frame-ancestors 'self'"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "SAMEORIGIN")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Content-Security-Policy", csp)
			next.ServeHTTP(w, r)
		})
	}
}
