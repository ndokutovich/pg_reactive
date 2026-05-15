package realtime

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// newWebhookManagerWithHooks builds a WebhookManager with a fixed webhook set,
// bypassing the database. The webhooks field is package-private so this test
// (same package) can set it directly.
func newWebhookManagerWithHooks(hooks []Webhook) *WebhookManager {
	return &WebhookManager{
		webhooks: hooks,
		client:   &http.Client{Timeout: 2 * time.Second},
	}
}

// captureServer is an httptest server that records the bodies it receives.
type captureServer struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []string
}

func newCaptureServer() *captureServer {
	cs := &captureServer{}
	cs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cs.mu.Lock()
		cs.bodies = append(cs.bodies, string(body))
		cs.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	return cs
}

func (cs *captureServer) received() []string {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	out := make([]string, len(cs.bodies))
	copy(out, cs.bodies)
	return out
}

// waitForBodies polls until n bodies have arrived or the deadline passes.
func (cs *captureServer) waitForBodies(n int, d time.Duration) []string {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if got := cs.received(); len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cs.received()
}

func TestDeliverFromWebhookNotify_MatchesTableAndEvent(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"INSERT"}, TableName: "orders", Active: true},
	})

	wm.DeliverFromWebhookNotify(`{"table":"orders","event":"INSERT","record":{"id":42},"old_record":null}`)

	bodies := srv.waitForBodies(1, time.Second)
	if len(bodies) != 1 {
		t.Fatalf("expected 1 delivery, got %d", len(bodies))
	}
	var wp WebhookPayload
	if err := json.Unmarshal([]byte(bodies[0]), &wp); err != nil {
		t.Fatalf("delivered body not valid JSON: %v", err)
	}
	if wp.Table != "orders" || wp.Event != "INSERT" {
		t.Errorf("delivered payload = %+v, want table=orders event=INSERT", wp)
	}
	if string(wp.Record) != `{"id":42}` {
		t.Errorf("record = %s, want {\"id\":42}", wp.Record)
	}
	// old_record was JSON null — omitempty + nilIfJSONNull should drop it.
	if wp.OldRecord != nil {
		t.Errorf("old_record = %s, want nil", wp.OldRecord)
	}
}

func TestDeliverFromWebhookNotify_SkipsNonMatchingTable(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"*"}, TableName: "orders", Active: true},
	})

	wm.DeliverFromWebhookNotify(`{"table":"customers","event":"INSERT","record":{"id":1}}`)

	// Give any erroneous async delivery a chance to land.
	if bodies := srv.waitForBodies(1, 150*time.Millisecond); len(bodies) != 0 {
		t.Errorf("expected no delivery for non-matching table, got %d", len(bodies))
	}
}

func TestDeliverFromWebhookNotify_SkipsNonMatchingEvent(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"INSERT"}, TableName: "orders", Active: true},
	})

	wm.DeliverFromWebhookNotify(`{"table":"orders","event":"DELETE","old_record":{"id":1}}`)

	if bodies := srv.waitForBodies(1, 150*time.Millisecond); len(bodies) != 0 {
		t.Errorf("expected no delivery for non-matching event, got %d", len(bodies))
	}
}

func TestDeliverFromWebhookNotify_WildcardTableMatchesAll(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"*"}, TableName: "*", Active: true},
	})

	wm.DeliverFromWebhookNotify(`{"table":"anything","event":"UPDATE","record":{"x":1},"old_record":{"x":0}}`)

	bodies := srv.waitForBodies(1, time.Second)
	if len(bodies) != 1 {
		t.Fatalf("expected 1 delivery for wildcard webhook, got %d", len(bodies))
	}
}

func TestDeliverFromWebhookNotify_SkipsInactive(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"*"}, TableName: "*", Active: false},
	})

	wm.DeliverFromWebhookNotify(`{"table":"orders","event":"INSERT","record":{"id":1}}`)

	if bodies := srv.waitForBodies(1, 150*time.Millisecond); len(bodies) != 0 {
		t.Errorf("expected no delivery for inactive webhook, got %d", len(bodies))
	}
}

func TestDeliverFromWebhookNotify_IgnoresInvalidPayload(t *testing.T) {
	srv := newCaptureServer()
	defer srv.Close()

	wm := newWebhookManagerWithHooks([]Webhook{
		{ID: "1", URL: srv.URL, Events: []string{"*"}, TableName: "*", Active: true},
	})

	// Not JSON, and a payload missing table/event — neither should deliver or panic.
	wm.DeliverFromWebhookNotify(`not json at all`)
	wm.DeliverFromWebhookNotify(`{"event":"INSERT"}`)
	wm.DeliverFromWebhookNotify(`{"table":"orders"}`)

	if bodies := srv.waitForBodies(1, 150*time.Millisecond); len(bodies) != 0 {
		t.Errorf("expected no delivery for invalid payloads, got %d", len(bodies))
	}
}

func TestNilIfJSONNull(t *testing.T) {
	if got := nilIfJSONNull(json.RawMessage(`null`)); got != nil {
		t.Errorf("nilIfJSONNull(null) = %s, want nil", got)
	}
	if got := nilIfJSONNull(json.RawMessage(``)); got != nil {
		t.Errorf("nilIfJSONNull(empty) = %s, want nil", got)
	}
	if got := nilIfJSONNull(json.RawMessage(`{"id":1}`)); string(got) != `{"id":1}` {
		t.Errorf("nilIfJSONNull(obj) = %s, want {\"id\":1}", got)
	}
}
