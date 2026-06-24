package middleware

import (
	"net/http"
	"os"
)

// PublicSecurityHeaders returns middleware that applies security headers for
// user-facing SPAs served from the public/ directory. More permissive than
// API SecurityHeaders but still enforces frame protection and content-type
// sniffing prevention.
//
// allowInlineScripts adds 'unsafe-inline' to the script-src CSP directive —
// off by default (strict). Enable it only for static apps that rely on inline
// <script> blocks (e.g. the pg_reactive examples); a modern bundled SPA keeps
// all scripts external and should leave it off.
//
// The CSP can be overridden entirely via the CSP_POLICY env var. When set,
// it replaces the computed policy verbatim — letting operators tighten or
// relax the policy without rebuilding the binary.
func PublicSecurityHeaders(allowInlineScripts bool) func(http.Handler) http.Handler {
	scriptSrc := "script-src 'self'"
	if allowInlineScripts {
		// Required only for legacy static apps with inline <script>. Modern
		// bundled SPAs (Vite/webpack/esbuild) emit external <script src> tags
		// and should keep this off — inline scripts are the primary XSS payload.
		// cdn.jsdelivr.net is allowed in this mode because the bundled pg_reactive
		// example pages load Chart.js from it; scoped to the inline-scripts (demo)
		// mode so the strict default stays strict. Override entirely via CSP_POLICY.
		scriptSrc = "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
	}
	csp := "default-src 'self'; " +
		scriptSrc + "; " +
		// 'unsafe-inline' for style-src — Vite/CSS-in-JS frameworks inject
		// inline <style> tags and inline style="" attributes at runtime.
		// Style-based XSS is far less dangerous than script-based.
		"style-src 'self' 'unsafe-inline'; " +
		// data: + blob: for inline SVG icons and runtime-generated textures.
		"img-src 'self' data: blob:; " +
		"font-src 'self' data:; " +
		// ws:/wss: for the game channel + LiveQuery WebSocket relays.
		"connect-src 'self' ws: wss:; " +
		// blob: for Vite-emitted Web Workers (and Three.js worker-based loaders).
		"worker-src 'self' blob:; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'; " +
		"frame-ancestors 'none'"

	// CSP_POLICY env override — verbatim replacement for deployments that
	// need a custom policy (e.g. a CDN allowlist, a report-uri directive).
	if override := os.Getenv("CSP_POLICY"); override != "" {
		csp = override
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Content-Security-Policy", csp)
			next.ServeHTTP(w, r)
		})
	}
}
