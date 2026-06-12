package functions

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// gemini audit P2: DenoHealth must not block forever when the edge-runtime
// accepts the connection but never sends a response. The probe is bounded by a
// request-context deadline (denoHealthTimeout); a hung upstream yields 502
// promptly instead of wedging the handler goroutine and leaking a connection.
func TestDenoHealth_TimesOutOnHungUpstream(t *testing.T) {
	// Upstream that accepts the request and never responds within the test window.
	hung := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done(): // client (our probe) gave up
		case <-time.After(10 * time.Second):
		}
	}))
	defer hung.Close()

	orig := denoHealthTimeout
	denoHealthTimeout = 150 * time.Millisecond
	defer func() { denoHealthTimeout = orig }()

	h := DenoHealth(&FunctionsDeps{EdgeRuntimeURL: hung.URL})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/functions/v1/_health", nil)

	done := make(chan int, 1)
	go func() {
		h(rec, req)
		done <- rec.Code
	}()

	select {
	case code := <-done:
		if code != http.StatusBadGateway {
			t.Fatalf("hung edge-runtime must yield 502, got %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("DenoHealth did not return within 2s — the deadline did not bound the probe")
	}
}
