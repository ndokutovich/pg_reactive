package realtime

import (
	"encoding/json"
	"testing"
	"time"
)

// Regression for finding F8 (security audit 2026-05): a client must not be
// able to inject arbitrary messages into another subscriber's delta stream.

func TestDispatchClientMessage_DropsNonPresence(t *testing.T) {
	hub := NewHub()
	const qid = "q1"
	// Client B subscribes — we'll watch its channel.
	ch := hub.Subscribe(qid, 4)
	defer hub.Unsubscribe(qid, ch)

	// Client A tries to forge a delta.
	fake := []byte(`{"query_id":"q1","inserted":[{"forged":true}],"deleted":[]}`)
	dispatchClientMessage(hub, qid, "client-A", fake)

	select {
	case got := <-ch:
		t.Fatalf("forged delta leaked to other subscriber: %s", got)
	case <-time.After(50 * time.Millisecond):
		// expected: nothing arrived
	}
}

func TestDispatchClientMessage_DropsMalformedJSON(t *testing.T) {
	hub := NewHub()
	ch := hub.Subscribe("q2", 4)
	defer hub.Unsubscribe("q2", ch)

	dispatchClientMessage(hub, "q2", "client-A", []byte(`not json`))
	dispatchClientMessage(hub, "q2", "client-A", []byte(`{`))
	dispatchClientMessage(hub, "q2", "client-A", []byte(``))

	select {
	case got := <-ch:
		t.Fatalf("malformed message leaked: %s", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDispatchClientMessage_DropsUnknownTypes(t *testing.T) {
	hub := NewHub()
	ch := hub.Subscribe("q3", 4)
	defer hub.Unsubscribe("q3", ch)

	for _, msg := range []string{
		`{"type":"delta","inserted":[1,2,3]}`,
		`{"type":"invalidated"}`,
		`{"type":"subscribed"}`,
		`{"inserted":[{"x":1}]}`,
		`{"type":""}`,
	} {
		dispatchClientMessage(hub, "q3", "client-A", []byte(msg))
	}

	select {
	case got := <-ch:
		t.Fatalf("disallowed-type message leaked: %s", got)
	case <-time.After(50 * time.Millisecond):
	}
}

// Whitelisted: type=broadcast must reach peers, but wrapped in an envelope
// the receiver cannot confuse with a server-delta.
func TestDispatchClientMessage_BroadcastIsWrappedAndDelivered(t *testing.T) {
	hub := NewHub()
	const qid = "q6"
	ch := hub.Subscribe(qid, 4)
	defer hub.Unsubscribe(qid, ch)

	dispatchClientMessage(hub, qid, "peer-A",
		[]byte(`{"type":"broadcast","payload":{"hello":"world"}}`))

	select {
	case got := <-ch:
		var env map[string]any
		if err := json.Unmarshal([]byte(got), &env); err != nil {
			t.Fatalf("broadcast envelope not JSON: %v", err)
		}
		if env["type"] != "broadcast" {
			t.Fatalf("envelope must keep type=broadcast, got %v", env["type"])
		}
		if env["from"] != "peer-A" {
			t.Fatalf("server must inject from=peer-A, got %v", env["from"])
		}
		// Envelope must NOT carry the {inserted,deleted} shape that the SDK
		// uses to detect server-deltas — otherwise injection is back.
		if _, hasInserted := env["inserted"]; hasInserted {
			t.Fatal("broadcast envelope leaked 'inserted' field — receiver could confuse with delta")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("broadcast did not reach the peer channel")
	}
}

func TestDispatchClientMessage_PresenceStillWorks(t *testing.T) {
	hub := NewHub()
	const qid = "q4"
	// Subscribe a watcher AFTER the join so we only see the update.
	hub.PresenceJoin(qid, "client-A", json.RawMessage(`{"state":"initial"}`))

	ch := hub.Subscribe(qid, 4)
	defer hub.Unsubscribe(qid, ch)

	dispatchClientMessage(hub, qid, "client-A",
		[]byte(`{"type":"presence","state":{"typing":true}}`))

	select {
	case got := <-ch:
		var ev map[string]any
		if err := json.Unmarshal([]byte(got), &ev); err != nil {
			t.Fatalf("presence event not valid JSON: %v", err)
		}
		switch ev["type"] {
		case "presence_update", "presence_change", "presence_state":
			// expected: PresenceUpdate may produce any of these
		default:
			t.Fatalf("unexpected event type: %v", ev["type"])
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("presence message did not produce an event")
	}
}

func TestDispatchClientMessage_PresenceDefaultsClientID(t *testing.T) {
	hub := NewHub()
	const qid = "q5"

	dispatchClientMessage(hub, qid, "fallback-id",
		[]byte(`{"type":"presence","state":{"x":1}}`))

	list := hub.PresenceList(qid)
	if _, ok := list["fallback-id"]; !ok {
		t.Fatalf("presence without client_id should fall back to connection id, got keys: %v", keys(list))
	}
}

func keys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
