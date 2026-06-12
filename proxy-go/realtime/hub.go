package realtime

import (
	"encoding/json"
	"sync"

	"github.com/rs/zerolog/log"
)

// subscriber is one connected client's delivery slot. authorize re-evaluates
// whether this client may still receive data under a (possibly changed)
// audience; revoke is closed exactly once to force the connection to
// disconnect when it no longer may (round 39 F1).
type subscriber struct {
	ch        chan string
	authorize func(audience string) bool
	revoke    chan struct{}
	once      sync.Once
}

// Revoke signals the connection to disconnect. Idempotent and concurrency-safe.
func (s *subscriber) Revoke() { s.once.Do(func() { close(s.revoke) }) }

// Hub provides fan-out delivery of NOTIFY payloads to multiple concurrent
// WebSocket subscribers. Each subscriber gets its own buffered channel so
// that a single NOTIFY message is delivered to ALL connected clients.
//
// A plain chan string cannot fan out: in Go, each channel receive consumes
// the message, so only one goroutine would see it. Hub fixes this by
// maintaining a slice of per-subscriber channels and writing to every one.
type Hub struct {
	mu   sync.RWMutex
	subs map[string][]*subscriber

	// Presence: channel → clientID → state
	pmu      sync.RWMutex
	presence map[string]map[string]json.RawMessage
}

// NewHub creates an empty Hub.
func NewHub() *Hub {
	return &Hub{
		subs:     make(map[string][]*subscriber),
		presence: make(map[string]map[string]json.RawMessage),
	}
}

// Subscribe registers a new subscriber for queryID and returns its slot.
// authorize is the connect-time audience gate, re-runnable against the CURRENT
// audience so a re-registered subscription can revoke a now-unauthorized
// connection (round 39 F1). The caller MUST call Unsubscribe when the
// connection closes to avoid goroutine and memory leaks.
func (h *Hub) Subscribe(queryID string, capacity int, authorize func(audience string) bool) *subscriber {
	if authorize == nil {
		authorize = func(string) bool { return true }
	}
	s := &subscriber{
		ch:        make(chan string, capacity),
		authorize: authorize,
		revoke:    make(chan struct{}),
	}
	h.mu.Lock()
	h.subs[queryID] = append(h.subs[queryID], s)
	h.mu.Unlock()
	return s
}

// Unsubscribe removes s from the subscriber list for queryID. It is safe
// to call concurrently with Subscribe and Broadcast.
func (h *Hub) Unsubscribe(queryID string, s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := h.subs[queryID]
	for i, x := range subs {
		if x == s {
			// Remove by swapping with last element and shrinking.
			last := len(subs) - 1
			subs[i] = subs[last]
			h.subs[queryID] = subs[:last]
			break
		}
	}
	if len(h.subs[queryID]) == 0 {
		delete(h.subs, queryID)
	}
}

// snapshot returns a copy of the subscriber slice for queryID under RLock.
func (h *Hub) snapshot(queryID string) []*subscriber {
	h.mu.RLock()
	snap := make([]*subscriber, len(h.subs[queryID]))
	copy(snap, h.subs[queryID])
	h.mu.RUnlock()
	return snap
}

// Broadcast delivers payload to every subscriber registered for queryID
// WITHOUT re-checking authorization. Used for presence/channel events, not
// live-query data — deltas go through BroadcastDelta.
// Non-blocking per subscriber: if a subscriber's buffer is full the message
// is silently dropped for that subscriber only; all others still receive it.
func (h *Hub) Broadcast(queryID, payload string) {
	snap := h.snapshot(queryID)
	log.Debug().Str("query_id", queryID).Int("subscribers", len(snap)).Msg("Hub.Broadcast")
	for _, s := range snap {
		select {
		case s.ch <- payload:
		default:
			// subscriber buffer full — message dropped for this subscriber only
			log.Warn().Str("query_id", queryID).Msg("Hub.Broadcast: subscriber buffer full, dropping")
		}
	}
}

// BroadcastDelta delivers a live-query delta only to subscribers STILL
// authorized under the subscription's CURRENT audience, and revokes (forces
// the disconnect of) any whose authorization no longer holds. This closes the
// stale-permission window where a connection authorized under an old audience
// keeps reading a re-registered — e.g. now-private — subscription (round 39 F1
// HIGH). The caller resolves the current audience from the transactional
// catalog (subscription_meta) once per delta.
func (h *Hub) BroadcastDelta(queryID, payload, audience string) {
	snap := h.snapshot(queryID)
	log.Debug().Str("query_id", queryID).Int("subscribers", len(snap)).Msg("Hub.BroadcastDelta")
	for _, s := range snap {
		if !s.authorize(audience) {
			s.Revoke()
			continue
		}
		select {
		case s.ch <- payload:
		default:
			log.Warn().Str("query_id", queryID).Msg("Hub.BroadcastDelta: subscriber buffer full, dropping")
		}
	}
}

// ── Presence ────────────────────────────────────────────────────────────

// PresenceJoin registers a client in the presence map and broadcasts a join event.
func (h *Hub) PresenceJoin(channel, clientID string, state json.RawMessage) {
	h.pmu.Lock()
	if h.presence[channel] == nil {
		h.presence[channel] = make(map[string]json.RawMessage)
	}
	h.presence[channel][clientID] = state
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type":      "presence_join",
		"channel":   channel,
		"client_id": clientID,
		"state":     json.RawMessage(state),
	})
	h.Broadcast(channel, string(event))
}

// PresenceLeave removes a client from the presence map and broadcasts a leave event.
func (h *Hub) PresenceLeave(channel, clientID string) {
	h.pmu.Lock()
	if m := h.presence[channel]; m != nil {
		delete(m, clientID)
		if len(m) == 0 {
			delete(h.presence, channel)
		}
	}
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type":      "presence_leave",
		"channel":   channel,
		"client_id": clientID,
	})
	h.Broadcast(channel, string(event))
}

// PresenceUpdate updates a client's state and broadcasts the update.
func (h *Hub) PresenceUpdate(channel, clientID string, state json.RawMessage) {
	h.pmu.Lock()
	if h.presence[channel] == nil {
		h.presence[channel] = make(map[string]json.RawMessage)
	}
	h.presence[channel][clientID] = state
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type":      "presence_state",
		"channel":   channel,
		"client_id": clientID,
		"state":     json.RawMessage(state),
	})
	h.Broadcast(channel, string(event))
}

// PresenceList returns the current presence state for a channel.
func (h *Hub) PresenceList(channel string) map[string]json.RawMessage {
	h.pmu.RLock()
	defer h.pmu.RUnlock()

	m := h.presence[channel]
	if m == nil {
		return make(map[string]json.RawMessage)
	}

	// Return a copy
	result := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		result[k] = v
	}
	return result
}
