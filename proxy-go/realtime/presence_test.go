package realtime

import (
	"encoding/json"
	"strings"
	"testing"
)

// ── PresenceJoin ──────────────────────────────────────────────────────────────

func TestPresenceJoin_AddsClientToMap(t *testing.T) {
	h := NewHub()
	state := json.RawMessage(`{"status":"online"}`)

	h.PresenceJoin("room-1", "client-a", state, 0)

	list := h.PresenceList("room-1")
	if len(list) != 1 {
		t.Fatalf("expected 1 presence entry, got %d", len(list))
	}
	got, ok := list["client-a"]
	if !ok {
		t.Fatal("expected client-a in presence list")
	}
	if string(got) != string(state) {
		t.Errorf("state mismatch: got %s, want %s", got, state)
	}
}

func TestPresenceJoin_BroadcastsJoinEvent(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("room-1", 10, 0)
	ch := sub.ch
	defer h.Unsubscribe("room-1", sub)

	h.PresenceJoin("room-1", "client-b", json.RawMessage(`{"x":1}`), 0)

	select {
	case msg := <-ch:
		var event map[string]any
		if err := json.Unmarshal([]byte(msg), &event); err != nil {
			t.Fatalf("broadcast message is not valid JSON: %v", err)
		}
		if event["type"] != "presence_join" {
			t.Errorf("expected type=presence_join, got %q", event["type"])
		}
		if event["client_id"] != "client-b" {
			t.Errorf("expected client_id=client-b, got %q", event["client_id"])
		}
		if event["channel"] != "room-1" {
			t.Errorf("expected channel=room-1, got %q", event["channel"])
		}
	default:
		t.Fatal("expected a presence_join broadcast, channel was empty")
	}
}

// ── PresenceLeave ─────────────────────────────────────────────────────────────

func TestPresenceLeave_RemovesClient(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-2", "client-c", json.RawMessage(`{}`), 0)
	h.PresenceLeave("room-2", "client-c", 0)

	list := h.PresenceList("room-2")
	if len(list) != 0 {
		t.Fatalf("expected empty presence after leave, got %d entries", len(list))
	}
}

func TestPresenceLeave_BroadcastsLeaveEvent(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("room-2", 10, 0)
	ch := sub.ch
	defer h.Unsubscribe("room-2", sub)

	// Drain the join event first.
	h.PresenceJoin("room-2", "client-d", json.RawMessage(`{}`), 0)
	<-ch

	h.PresenceLeave("room-2", "client-d", 0)

	select {
	case msg := <-ch:
		var event map[string]any
		if err := json.Unmarshal([]byte(msg), &event); err != nil {
			t.Fatalf("broadcast is not valid JSON: %v", err)
		}
		if event["type"] != "presence_leave" {
			t.Errorf("expected type=presence_leave, got %q", event["type"])
		}
		if event["client_id"] != "client-d" {
			t.Errorf("expected client_id=client-d, got %q", event["client_id"])
		}
	default:
		t.Fatal("expected a presence_leave broadcast, channel was empty")
	}
}

func TestPresenceLeave_RemovesChannelWhenLastClientLeaves(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-3", "only-client", json.RawMessage(`{}`), 0)
	h.PresenceLeave("room-3", "only-client", 0)

	// Internal map should no longer contain the channel key.
	h.pmu.RLock()
	_, exists := h.presence["room-3"]
	h.pmu.RUnlock()

	if exists {
		t.Fatal("expected channel to be removed from presence map after last client leaves")
	}
}

func TestPresenceLeave_NoopForUnknownClient(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-4", "client-e", json.RawMessage(`{}`), 0)

	// Should not panic or remove the existing client.
	h.PresenceLeave("room-4", "nonexistent-client", 0)

	list := h.PresenceList("room-4")
	if len(list) != 1 {
		t.Fatalf("existing client should remain after unknown client leaves, got %d", len(list))
	}
}

// ── PresenceUpdate ────────────────────────────────────────────────────────────

func TestPresenceUpdate_UpdatesClientState(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-5", "client-f", json.RawMessage(`{"status":"away"}`), 0)
	h.PresenceUpdate("room-5", "client-f", json.RawMessage(`{"status":"online"}`), 0)

	list := h.PresenceList("room-5")
	got, ok := list["client-f"]
	if !ok {
		t.Fatal("client-f not found after update")
	}
	if !strings.Contains(string(got), "online") {
		t.Errorf("expected updated state to contain 'online', got %s", got)
	}
}

func TestPresenceUpdate_BroadcastsStateEvent(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("room-5", 10, 0)
	ch := sub.ch
	defer h.Unsubscribe("room-5", sub)

	// Drain join broadcast.
	h.PresenceJoin("room-5", "client-g", json.RawMessage(`{}`), 0)
	<-ch

	h.PresenceUpdate("room-5", "client-g", json.RawMessage(`{"typing":true}`), 0)

	select {
	case msg := <-ch:
		var event map[string]any
		if err := json.Unmarshal([]byte(msg), &event); err != nil {
			t.Fatalf("broadcast is not valid JSON: %v", err)
		}
		if event["type"] != "presence_state" {
			t.Errorf("expected type=presence_state, got %q", event["type"])
		}
		if event["client_id"] != "client-g" {
			t.Errorf("expected client_id=client-g, got %q", event["client_id"])
		}
	default:
		t.Fatal("expected a presence_state broadcast, channel was empty")
	}
}

func TestPresenceUpdate_CreatesEntryIfClientNotPreviouslyJoined(t *testing.T) {
	h := NewHub()
	// Update without a prior join — should still work (implementation creates the map entry).
	h.PresenceUpdate("room-6", "late-joiner", json.RawMessage(`{"status":"busy"}`), 0)

	list := h.PresenceList("room-6")
	if _, ok := list["late-joiner"]; !ok {
		t.Fatal("expected late-joiner to be added by PresenceUpdate")
	}
}

// ── PresenceList ──────────────────────────────────────────────────────────────

func TestPresenceList_EmptyForUnknownChannel(t *testing.T) {
	h := NewHub()
	list := h.PresenceList("channel-that-does-not-exist")
	if list == nil {
		t.Fatal("PresenceList must return a non-nil map, not nil")
	}
	if len(list) != 0 {
		t.Fatalf("expected empty map for unknown channel, got %d entries", len(list))
	}
}

func TestPresenceList_ReturnsCopyNotReference(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-7", "client-h", json.RawMessage(`{"v":1}`), 0)

	list1 := h.PresenceList("room-7")
	// Mutate the copy.
	list1["injected"] = json.RawMessage(`{}`)

	list2 := h.PresenceList("room-7")
	if _, ok := list2["injected"]; ok {
		t.Fatal("PresenceList must return a copy: mutation of returned map should not affect internal state")
	}
}

// ── Multiple clients on same channel ─────────────────────────────────────────

func TestPresence_MultipleClientsOnSameChannel(t *testing.T) {
	h := NewHub()
	sub := h.Subscribe("room-8", 20, 0)
	defer h.Unsubscribe("room-8", sub)

	clients := []string{"c1", "c2", "c3"}
	for _, id := range clients {
		h.PresenceJoin("room-8", id, json.RawMessage(`{"id":"`+id+`"}`), 0)
	}

	list := h.PresenceList("room-8")
	if len(list) != len(clients) {
		t.Fatalf("expected %d clients in presence, got %d", len(clients), len(list))
	}
	for _, id := range clients {
		if _, ok := list[id]; !ok {
			t.Errorf("expected client %q in presence list", id)
		}
	}
}

func TestPresence_RemovingOneClientLeavesOthers(t *testing.T) {
	h := NewHub()
	h.PresenceJoin("room-9", "keep-1", json.RawMessage(`{}`), 0)
	h.PresenceJoin("room-9", "keep-2", json.RawMessage(`{}`), 0)
	h.PresenceJoin("room-9", "leave-me", json.RawMessage(`{}`), 0)

	h.PresenceLeave("room-9", "leave-me", 0)

	list := h.PresenceList("room-9")
	if len(list) != 2 {
		t.Fatalf("expected 2 remaining clients, got %d", len(list))
	}
	if _, ok := list["leave-me"]; ok {
		t.Error("leave-me should no longer be in the presence list")
	}
	if _, ok := list["keep-1"]; !ok {
		t.Error("keep-1 should still be in the presence list")
	}
	if _, ok := list["keep-2"]; !ok {
		t.Error("keep-2 should still be in the presence list")
	}

	// Channel must still exist in internal map since two clients remain.
	h.pmu.RLock()
	_, exists := h.presence["room-9"]
	h.pmu.RUnlock()
	if !exists {
		t.Fatal("channel map entry should persist while clients remain")
	}
}
