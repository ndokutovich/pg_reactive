package middleware

import (
	"net/http"
	"strings"
	"time"
)

const corsMaxAge = int(time.Hour / time.Second) // 3600

// CORSMiddleware returns an HTTP middleware that sets CORS headers.
//
// Three modes:
//   - allowedOrigins non-empty: only those origins receive Access-Control-Allow-Origin.
//   - allowedOrigins empty + allowPermissive=true: reflects any Origin with credentials=true
//     (DEV ONLY — a public deployment in this mode is a CSRF/exfiltration target).
//   - allowedOrigins empty + allowPermissive=false (default since the security audit):
//     no Access-Control-Allow-Origin header is sent; cross-origin browsers will block
//     credentialed requests. Set ALLOWED_ORIGINS for prod or ALLOW_PERMISSIVE_CORS=true
//     for dev.
func CORSMiddleware(allowedOrigins []string, allowPermissive bool) func(http.Handler) http.Handler {
	allowedMethods := "GET, POST, PATCH, DELETE, OPTIONS"
	allowedHeaders := "Authorization, Content-Type, apikey, Prefer"
	exposedHeaders := "Content-Type, Content-Range"
	maxAge := "3600"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			switch {
			case len(allowedOrigins) > 0:
				if originAllowed(origin, allowedOrigins) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
			case allowPermissive:
				if origin != "" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
				} else {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				}
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			default:
				// Strict by default: no Allow-Origin emitted. Cross-origin browsers
				// will block credentialed requests; same-origin requests are
				// unaffected. CLI/server-to-server clients (no Origin header) work.
			}

			w.Header().Set("Access-Control-Allow-Methods", allowedMethods)
			w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
			w.Header().Set("Access-Control-Expose-Headers", exposedHeaders)
			w.Header().Set("Access-Control-Max-Age", maxAge)

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func originAllowed(origin string, allowed []string) bool {
	for _, o := range allowed {
		if strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}
