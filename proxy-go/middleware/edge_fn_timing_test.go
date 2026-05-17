package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// captureLogs redirects the zerolog global logger to an in-memory buffer for
// the duration of the test and restores it on cleanup.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := log.Logger
	log.Logger = zerolog.New(buf).With().Timestamp().Logger()
	t.Cleanup(func() { log.Logger = prev })
	return buf
}

func decodeLogLine(t *testing.T, line []byte) map[string]any {
	t.Helper()
	out := map[string]any{}
	if err := json.Unmarshal(line, &out); err != nil {
		t.Fatalf("log line not valid JSON: %v\nline: %s", err, string(line))
	}
	return out
}

func TestEdgeFnTiming_LogsFnNameAndStatusOK(t *testing.T) {
	buf := captureLogs(t)
	h := EdgeFnTiming(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/functions/v1/pickup-brainrot", nil)
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	entry := decodeLogLine(t, buf.Bytes())
	if got := entry["message"]; got != "edge_fn_duration" {
		t.Errorf("message = %v, want edge_fn_duration", got)
	}
	if got := entry["fn"]; got != "pickup-brainrot" {
		t.Errorf("fn = %v, want pickup-brainrot", got)
	}
	if got := entry["status"]; got != float64(http.StatusOK) {
		t.Errorf("status = %v, want 200", got)
	}
	if _, ok := entry["ms"]; !ok {
		t.Error("missing ms field")
	}
}

func TestEdgeFnTiming_LogsFailedStatus(t *testing.T) {
	buf := captureLogs(t)
	h := EdgeFnTiming(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/functions/v1/create-room", nil)
	h.ServeHTTP(rec, r)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	entry := decodeLogLine(t, buf.Bytes())
	if got := entry["fn"]; got != "create-room" {
		t.Errorf("fn = %v, want create-room", got)
	}
	if got := entry["status"]; got != float64(http.StatusInternalServerError) {
		t.Errorf("status = %v, want 500", got)
	}
}

func TestEdgeFnTiming_ImplicitOKWhenHandlerOnlyWrites(t *testing.T) {
	buf := captureLogs(t)
	h := EdgeFnTiming(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hello"))
	}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/functions/v1/heartbeat", nil)
	h.ServeHTTP(rec, r)

	entry := decodeLogLine(t, buf.Bytes())
	if got := entry["status"]; got != float64(http.StatusOK) {
		t.Errorf("status = %v, want 200 (implicit)", got)
	}
	if got := entry["fn"]; got != "heartbeat" {
		t.Errorf("fn = %v, want heartbeat", got)
	}
}

// Round-22 F4: conditional capability wrapping. The wrapper should expose
// the optional interfaces the UNDERLYING ResponseWriter supports, no more
// and no less — so a type-asserting caller gets a truthful answer.

type onlyWriter struct{ http.ResponseWriter }

func TestEdgeFnTiming_OnlyExposesUnderlyingCapabilities(t *testing.T) {
	// Bare ResponseWriter that supports NO optional interfaces.
	bare := &onlyWriter{ResponseWriter: httptest.NewRecorder()}
	var captured http.ResponseWriter
	h := EdgeFnTiming(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = w
	}))
	h.ServeHTTP(bare, httptest.NewRequest(http.MethodGet, "/functions/v1/x", nil))

	if _, ok := captured.(http.Flusher); ok {
		t.Error("wrapper exposes Flusher when underlying does not")
	}
	if _, ok := captured.(http.Hijacker); ok {
		t.Error("wrapper exposes Hijacker when underlying does not")
	}
	if _, ok := captured.(http.Pusher); ok {
		t.Error("wrapper exposes Pusher when underlying does not")
	}
	if _, ok := captured.(io.ReaderFrom); ok {
		t.Error("wrapper exposes io.ReaderFrom when underlying does not")
	}
}

func TestEdgeFnTiming_PreservesFlusherWhenUnderlyingSupports(t *testing.T) {
	// httptest.ResponseRecorder implements http.Flusher (as of Go 1.20+).
	rec := httptest.NewRecorder()
	var captured http.ResponseWriter
	h := EdgeFnTiming(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = w
	}))
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/functions/v1/x", nil))

	if _, ok := captured.(http.Flusher); !ok {
		t.Error("wrapper must expose Flusher when underlying writer is httptest.ResponseRecorder")
	}
	// Hijacker is NOT supported by httptest.ResponseRecorder.
	if _, ok := captured.(http.Hijacker); ok {
		t.Error("httptest.ResponseRecorder does not implement Hijacker; wrapper must not advertise it")
	}
}

func TestEdgeFnNameFromPath(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/functions/v1/pickup-brainrot", "pickup-brainrot"},
		{"/functions/v1/", ""},
		{"/functions/v1/_refresh", "_refresh"},
		{"/functions/v1/foo/bar", "foo"},
		{"/something-else", "/something-else"},
	}
	for _, tt := range tests {
		if got := edgeFnNameFromPath(tt.path); got != tt.want {
			t.Errorf("edgeFnNameFromPath(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}
