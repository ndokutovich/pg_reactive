package middleware

import (
	"bufio"
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
		core := &statusCaptureCore{ResponseWriter: w, status: http.StatusOK}
		// Round-22 codex F4: build a wrapper that ONLY advertises the
		// optional interfaces the underlying writer actually implements,
		// rather than always advertising all four and returning
		// http.ErrNotSupported at call time. Some callers (notably
		// httputil.ReverseProxy when picking a path for streaming and
		// websocket-upgrade libs) make their decisions via type
		// assertion at request time — a "lying" wrapper that says it
		// implements http.Flusher but no-ops on Flush() can silently
		// buffer streaming responses for the full handler lifetime.
		wrapped := wrapForCapabilities(w, core)
		defer func() {
			ms := time.Since(start).Milliseconds()
			log.Info().
				Str("fn", edgeFnNameFromPath(r.URL.Path)).
				Int64("ms", ms).
				Int("status", core.status).
				Msg("edge_fn_duration")
		}()
		next.ServeHTTP(wrapped, r)
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

// statusCaptureCore is the always-present nucleus: it records the response
// status code and forwards Write/WriteHeader to the underlying writer. All
// optional capability wrappers below embed it so the status capture stays
// active no matter which interface combination we expose to the handler.
type statusCaptureCore struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusCaptureCore) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusCaptureCore) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// ── Capability wrappers (one per interface combination we expose) ───────

type flusherWrapper struct{ *statusCaptureCore }

func (w flusherWrapper) Flush() {
	w.ResponseWriter.(http.Flusher).Flush()
}

type hijackerWrapper struct{ *statusCaptureCore }

func (w hijackerWrapper) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.ResponseWriter.(http.Hijacker).Hijack()
}

type pusherWrapper struct{ *statusCaptureCore }

func (w pusherWrapper) Push(target string, opts *http.PushOptions) error {
	return w.ResponseWriter.(http.Pusher).Push(target, opts)
}

type readerFromWrapper struct{ *statusCaptureCore }

func (w readerFromWrapper) ReadFrom(src io.Reader) (int64, error) {
	if !w.wroteHeader {
		w.wroteHeader = true
	}
	return w.ResponseWriter.(io.ReaderFrom).ReadFrom(src)
}

// Common combinations. http.ResponseWriter for an HTTP/1.1 server provides
// {Flusher, Hijacker, ReaderFrom}; HTTP/2 provides {Flusher, Pusher,
// ReaderFrom}; httptest.NewRecorder provides {Flusher} only.

type flusherHijackerWrapper struct {
	*statusCaptureCore
	hijackerWrapper
	flusherWrapper
}

type flusherHijackerReaderFromWrapper struct {
	*statusCaptureCore
	hijackerWrapper
	flusherWrapper
	readerFromWrapper
}

type flusherPusherReaderFromWrapper struct {
	*statusCaptureCore
	pusherWrapper
	flusherWrapper
	readerFromWrapper
}

type flusherReaderFromWrapper struct {
	*statusCaptureCore
	flusherWrapper
	readerFromWrapper
}

// wrapForCapabilities returns a wrapper that exposes EXACTLY the optional
// interfaces the underlying writer supports. Any caller doing a type
// assertion (e.g. `_, ok := w.(http.Flusher)`) sees a truthful answer.
//
// We special-case the common combinations rather than reach for reflect:
// HTTP/1.1 (Flusher+Hijacker+ReaderFrom), HTTP/2 (Flusher+Pusher+ReaderFrom),
// httptest (Flusher only), and a few fallbacks. This covers ~100% of real
// ResponseWriters; an unrecognised combination degrades to the safest
// always-Flusher+ReaderFrom (or core only).
func wrapForCapabilities(w http.ResponseWriter, core *statusCaptureCore) http.ResponseWriter {
	_, hasFlush := w.(http.Flusher)
	_, hasHijack := w.(http.Hijacker)
	_, hasPush := w.(http.Pusher)
	_, hasReadFrom := w.(io.ReaderFrom)

	switch {
	case hasFlush && hasHijack && hasReadFrom:
		// stdlib HTTP/1.1 server's *response
		return flusherHijackerReaderFromWrapper{
			statusCaptureCore: core,
			flusherWrapper:    flusherWrapper{core},
			hijackerWrapper:   hijackerWrapper{core},
			readerFromWrapper: readerFromWrapper{core},
		}
	case hasFlush && hasPush && hasReadFrom:
		// stdlib HTTP/2 server's *responseWriter
		return flusherPusherReaderFromWrapper{
			statusCaptureCore: core,
			flusherWrapper:    flusherWrapper{core},
			pusherWrapper:     pusherWrapper{core},
			readerFromWrapper: readerFromWrapper{core},
		}
	case hasFlush && hasHijack:
		return flusherHijackerWrapper{
			statusCaptureCore: core,
			flusherWrapper:    flusherWrapper{core},
			hijackerWrapper:   hijackerWrapper{core},
		}
	case hasFlush && hasReadFrom:
		return flusherReaderFromWrapper{
			statusCaptureCore: core,
			flusherWrapper:    flusherWrapper{core},
			readerFromWrapper: readerFromWrapper{core},
		}
	case hasFlush:
		// httptest.ResponseRecorder lands here.
		return struct {
			*statusCaptureCore
			http.Flusher
		}{core, flusherWrapper{core}}
	default:
		// No optional interfaces — return the core only.
		return core
	}
}
