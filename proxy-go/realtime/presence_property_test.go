package realtime

import (
	"encoding/json"
	"fmt"
	"testing"

	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generator helpers
// ---------------------------------------------------------------------------

// genChannelID generates a valid channel identifier string.
func genChannelID(t *rapid.T, label string) string {
	return rapid.StringMatching(`[a-z][a-z0-9\-]{0,19}`).Draw(t, label)
}

// genClientID generates a valid client identifier string.
func genClientID(t *rapid.T, label string) string {
	return rapid.StringMatching(`[a-z][a-z0-9\-]{0,15}`).Draw(t, label)
}

// genState generates arbitrary JSON state for a presence entry.
func genState(t *rapid.T, label string) json.RawMessage {
	key := rapid.StringMatching(`[a-z]{1,8}`).Draw(t, label+"_key")
	val := rapid.StringMatching(`[a-z0-9]{1,8}`).Draw(t, label+"_val")
	return json.RawMessage(fmt.Sprintf(`{%q:%q}`, key, val))
}

// ---------------------------------------------------------------------------
// Property 1: Join/Leave round-trip
// ---------------------------------------------------------------------------

// TestProperty_Presence_JoinLeaveRoundTrip verifies that after PresenceJoin
// followed by PresenceLeave, PresenceList for that channel returns an empty
// map (assuming only that one client was added).
func TestProperty_Presence_JoinLeaveRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		h := NewHub()

		channel := genChannelID(t, "channel")
		clientID := genClientID(t, "client")
		state := genState(t, "state")

		h.PresenceJoin(channel, clientID, state)
		h.PresenceLeave(channel, clientID)

		list := h.PresenceList(channel)
		if len(list) != 0 {
			t.Fatalf(
				"after Join then Leave, PresenceList must be empty: channel=%q client=%q got=%v",
				channel, clientID, list,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 2: Join idempotency
// ---------------------------------------------------------------------------

// TestProperty_Presence_JoinIdempotency verifies that calling PresenceJoin
// twice with the same clientID results in exactly one presence entry for
// that client on the channel (the second call is an upsert, not a duplicate).
func TestProperty_Presence_JoinIdempotency(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		h := NewHub()

		channel := genChannelID(t, "channel")
		clientID := genClientID(t, "client")
		state1 := genState(t, "state1")
		state2 := genState(t, "state2")

		h.PresenceJoin(channel, clientID, state1)
		h.PresenceJoin(channel, clientID, state2)

		list := h.PresenceList(channel)

		count := 0
		for k := range list {
			if k == clientID {
				count++
			}
		}

		if count != 1 {
			t.Fatalf(
				"joining twice with same clientID must result in exactly 1 entry: "+
					"channel=%q client=%q count=%d list=%v",
				channel, clientID, count, list,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 3: State preservation
// ---------------------------------------------------------------------------

// TestProperty_Presence_StatePreservation verifies that after
// PresenceUpdate(channel, client, state), PresenceList(channel)[client]
// returns exactly that state.
func TestProperty_Presence_StatePreservation(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		h := NewHub()

		channel := genChannelID(t, "channel")
		clientID := genClientID(t, "client")
		state := genState(t, "state")

		h.PresenceUpdate(channel, clientID, state)

		list := h.PresenceList(channel)
		got, ok := list[clientID]
		if !ok {
			t.Fatalf(
				"client not found in PresenceList after PresenceUpdate: channel=%q client=%q",
				channel, clientID,
			)
		}

		if string(got) != string(state) {
			t.Fatalf(
				"state mismatch after PresenceUpdate: channel=%q client=%q\n  got:  %s\n  want: %s",
				channel, clientID, got, state,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 4: Channel isolation
// ---------------------------------------------------------------------------

// TestProperty_Presence_ChannelIsolation verifies that joining a client on
// channel A has no effect on PresenceList for a distinct channel B.
func TestProperty_Presence_ChannelIsolation(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		h := NewHub()

		channelA := genChannelID(t, "channelA")
		channelB := genChannelID(t, "channelB")

		// Ensure the two channels are different.
		if channelA == channelB {
			return // skip — generator can occasionally produce the same value
		}

		clientID := genClientID(t, "client")
		state := genState(t, "state")

		h.PresenceJoin(channelA, clientID, state)

		listB := h.PresenceList(channelB)
		if len(listB) != 0 {
			t.Fatalf(
				"joining channel %q must not affect presence for channel %q: got %v",
				channelA, channelB, listB,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 5: List is a snapshot (mutation does not bleed into internal state)
// ---------------------------------------------------------------------------

// TestProperty_Presence_ListIsSnapshot verifies that mutating the map
// returned by PresenceList does not affect the next call to PresenceList —
// i.e. the returned map is a copy, not a reference to internal state.
func TestProperty_Presence_ListIsSnapshot(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		h := NewHub()

		channel := genChannelID(t, "channel")
		clientID := genClientID(t, "client")
		state := genState(t, "state")

		h.PresenceJoin(channel, clientID, state)

		// Obtain the first snapshot and mutate it by adding a foreign key.
		snapshot := h.PresenceList(channel)
		injectedKey := "injected-by-test-" + clientID
		snapshot[injectedKey] = json.RawMessage(`{"foreign":true}`)

		// A second call must not see the injected key.
		second := h.PresenceList(channel)
		if _, found := second[injectedKey]; found {
			t.Fatalf(
				"mutation of returned PresenceList map leaked into internal state: "+
					"channel=%q injected key %q appeared in second snapshot",
				channel, injectedKey,
			)
		}

		// The original client must still be present.
		if _, found := second[clientID]; !found {
			t.Fatalf(
				"original client %q disappeared from presence after snapshot mutation: channel=%q",
				clientID, channel,
			)
		}
	})
}
