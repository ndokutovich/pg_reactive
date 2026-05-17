package middleware

import (
	"bytes"
	"encoding/json"
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
