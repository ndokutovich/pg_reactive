package middleware

import "net/http"

// PublicSecurityHeaders applies security headers for user-facing SPAs served
// from the public/ directory. More permissive than API SecurityHeaders but
// still enforces frame protection and content-type sniffing prevention.
func PublicSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; "+
				"font-src 'self' data:; "+
				"connect-src 'self' ws: wss:; "+
				"frame-ancestors 'self'",
		)
		next.ServeHTTP(w, r)
	})
}
