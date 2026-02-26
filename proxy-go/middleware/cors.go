package middleware

import (
	"net/http"
	"strings"
	"time"
)

const corsMaxAge = int(time.Hour / time.Second) // 3600

// CORSMiddleware returns an HTTP middleware that sets CORS headers.
//
// When allowedOrigins is non-empty, only requests from those origins receive
// Access-Control-Allow-Origin. When empty, a very permissive wildcard policy
// is applied (suitable for local development only).
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	allowedMethods := "GET, POST, PATCH, DELETE, OPTIONS"
	allowedHeaders := "Authorization, Content-Type, apikey, prefer"
	exposedHeaders := "Content-Type"
	maxAge := "3600"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if len(allowedOrigins) == 0 {
				// Permissive dev mode
				if origin != "" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
				} else {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				}
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			} else {
				// Restricted origin list
				if originAllowed(origin, allowedOrigins) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
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
