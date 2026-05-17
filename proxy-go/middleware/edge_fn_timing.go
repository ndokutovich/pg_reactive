package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// EdgeFnTiming records the wall-clock duration of every edge function
// invocation and emits a single structured log line per request:
//
//	{"level":"info","msg":"edge_fn_duration","fn":"<name>","ms":<duration>,"status":<code>}
//
// The fn name is parsed from the URL path (segment after /functions/v1/).
// Special paths like "" (list) and "_refresh" are reported as-is so log
// aggregators can distinguish them from real function calls.
//
// This is a baseline observability hook — aggregation/percentiles happen at
// the log-shipping layer. Keep the per-request overhead minimal: one time
// capture, one defer, one log call.
func EdgeFnTiming(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusCaptureWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			ms := time.Since(start).Milliseconds()
			log.Info().
				Str("fn", edgeFnNameFromPath(r.URL.Path)).
				Int64("ms", ms).
				Int("status", sw.status).
				Msg("edge_fn_duration")
		}()
		next.ServeHTTP(sw, r)
	})
}

// edgeFnNameFromPath extracts the function name from a /functions/v1/<name>
// URL path. Returns "" for the list endpoint (/functions/v1or /functions/v1/).
func edgeFnNameFromPath(p string) string {
	const prefix = "/functions/v1/"
	if !strings.HasPrefix(p, prefix) {
		// Defensive — middleware is only mounted under /functions/v1, but in
		// case it gets reused on a wider scope return the raw path so log
		// readers can still see what hit it.
		return p
	}
	rest := p[len(prefix):]
	// Strip any trailing slash and downstream segments — only the first
	// segment after the prefix is the function name.
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

// statusCaptureWriter records the response status code written by downstream
// handlers so the timing log line can include it. Defaults to 200 when no
// WriteHeader is ever called (Go writes 200 implicitly on first Write).
type statusCaptureWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusCaptureWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusCaptureWriter) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}
