package realtime

import (
	"encoding/json"
	"sync"

	"github.com/rs/zerolog/log"
)

// Hub provides fan-out delivery of NOTIFY payloads to multiple concurrent
// WebSocket subscribers. Each subscriber gets its own buffered channel so
// that a single NOTIFY message is delivered to ALL connected clients.
//
// A plain chan string cannot fan out: in Go, each channel receive consumes
// the message, so only one goroutine would see it. Hub fixes this by
// maintaining a slice of per-subscriber channels and writing to every one.
type Hub struct {
	mu   sync.RWMutex
	subs map[string][]chan string

	// Presence: channel → clientID → state
	pmu      sync.RWMutex
	presence map[string]map[string]json.RawMessage
}

// NewHub creates an empty Hub.
func NewHub() *Hub {
	return &Hub{
		subs:     make(map[string][]chan string),
		presence: make(map[string]map[string]json.RawMessage),
	}
}

// Subscribe registers a new subscriber for queryID and returns its personal
// delivery channel. The caller MUST call Unsubscribe when the connection
// closes to avoid goroutine and memory leaks.
func (h *Hub) Subscribe(queryID string, capacity int) chan string {
	ch := make(chan string, capacity)
	h.mu.Lock()
	h.subs[queryID] = append(h.subs[queryID], ch)
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes ch from the subscriber list for queryID. It is safe
// to call concurrently with Subscribe and Broadcast.
func (h *Hub) Unsubscribe(queryID string, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := h.subs[queryID]
	for i, s := range subs {
		if s == ch {
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

// Broadcast delivers payload to every subscriber registered for queryID.
// Non-blocking per subscriber: if a subscriber's buffer is full the message
// is silently dropped for that subscriber only; all others still receive it.
func (h *Hub) Broadcast(queryID, payload string) {
	h.mu.RLock()
	snap := make([]chan string, len(h.subs[queryID]))
	copy(snap, h.subs[queryID])
	h.mu.RUnlock()
	log.Debug().Str("query_id", queryID).Int("subscribers", len(snap)).Msg("Hub.Broadcast")
	for _, ch := range snap {
		select {
		case ch <- payload:
		default:
			// subscriber buffer full — message dropped for this subscriber only
			log.Warn().Str("query_id", queryID).Msg("Hub.Broadcast: subscriber buffer full, dropping")
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
