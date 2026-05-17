package middleware

import (
	"bufio"
	"errors"
	"io"
	"net"
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
//
// Round-21 codex F2: the wrapper also delegates http.Flusher, http.Hijacker,
// http.Pusher, and io.ReaderFrom to the underlying writer when available.
// Without these passthroughs, mounting the middleware on routes that do
// reverse-proxy / streaming / hijack-based upgrades (the /functions/v1
// "deno" and "http" runtimes, anything that calls io.Copy from a file) would
// silently degrade — httputil.ReverseProxy in particular short-circuits to
// io.Copy through ReaderFrom and falls back to a generic per-buffer loop
// without it.
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

// Flush implements http.Flusher when the underlying ResponseWriter does.
// SSE, log tailing, and any chunked-streaming response needs this.
func (s *statusCaptureWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack implements http.Hijacker when the underlying writer does. Required
// for WebSocket upgrades reached via an edge function path.
func (s *statusCaptureWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := s.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, errors.New("edge_fn_timing: underlying ResponseWriter does not Hijack")
}

// Push implements http.Pusher (HTTP/2 server push) when the underlying
// writer does. Rare on edge fns but cheap to forward.
func (s *statusCaptureWriter) Push(target string, opts *http.PushOptions) error {
	if p, ok := s.ResponseWriter.(http.Pusher); ok {
		return p.Push(target, opts)
	}
	return http.ErrNotSupported
}

// ReadFrom lets httputil.ReverseProxy (and any io.Copy(w, src)) use the
// optimised path on the underlying writer. Without this it falls back to a
// 32 KiB-buffer copy loop and we lose splice/sendfile when the target file
// is a *os.File.
func (s *statusCaptureWriter) ReadFrom(src io.Reader) (int64, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	if rf, ok := s.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(src)
	}
	return io.Copy(s.ResponseWriter, src)
}
