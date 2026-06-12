package realtime

import (
	"encoding/json"
	"sync"

	"github.com/rs/zerolog/log"
)

// subscriber is one connected client's delivery slot. It is bound to the
// subscription GENERATION it authorized against at connect; revoke is closed
// exactly once to force the connection to disconnect when a re-registration
// (new generation) makes its authorization stale (round 39 batch-2).
type subscriber struct {
	ch         chan string
	generation int64
	revoke     chan struct{}
	once       sync.Once
}

// Revoke signals the connection to disconnect. Idempotent and concurrency-safe.
func (s *subscriber) Revoke() { s.once.Do(func() { close(s.revoke) }) }

func (s *subscriber) revoked() bool {
	select {
	case <-s.revoke:
		return true
	default:
		return false
	}
}

// presenceEntry is a presence row tagged with the generation of the connection
// that wrote it. Reads filter on generation so a client authorized for the
// current epoch never sees presence written by a connection of another epoch —
// generation is an opaque token, NOT comparable by order (round 39 batch-2
// gen-ordering audit).
type presenceEntry struct {
	state json.RawMessage
	gen   int64
}

// Hub provides generation-aware fan-out delivery to concurrent WebSocket
// subscribers. Authorization is bound to the generation: any subscribe/
// unsubscribe bumps the subscription's generation, the proxy revokes every
// connection NOT of the announced generation, and every message — delta,
// presence, or broadcast — is routed so a connection of one epoch can never
// receive (or read the presence of) another epoch.
type Hub struct {
	mu   sync.RWMutex
	subs map[string][]*subscriber

	// Presence: channel → clientID → {state, generation}
	pmu      sync.RWMutex
	presence map[string]map[string]presenceEntry
}

// NewHub creates an empty Hub.
func NewHub() *Hub {
	return &Hub{
		subs:     make(map[string][]*subscriber),
		presence: make(map[string]map[string]presenceEntry),
	}
}

// Subscribe registers a new subscriber for queryID bound to generation. The
// caller MUST call Unsubscribe when the connection closes.
func (h *Hub) Subscribe(queryID string, capacity int, generation int64) *subscriber {
	s := &subscriber{
		ch:         make(chan string, capacity),
		generation: generation,
		revoke:     make(chan struct{}),
	}
	h.mu.Lock()
	h.subs[queryID] = append(h.subs[queryID], s)
	h.mu.Unlock()
	return s
}

// Unsubscribe removes s from the subscriber list for queryID.
func (h *Hub) Unsubscribe(queryID string, s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := h.subs[queryID]
	for i, x := range subs {
		if x == s {
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

func (h *Hub) snapshot(queryID string) []*subscriber {
	h.mu.RLock()
	snap := make([]*subscriber, len(h.subs[queryID]))
	copy(snap, h.subs[queryID])
	h.mu.RUnlock()
	return snap
}

func deliver(queryID string, s *subscriber, payload string) {
	select {
	case s.ch <- payload:
	default:
		log.Warn().Str("query_id", queryID).Msg("Hub: subscriber buffer full, dropping")
	}
}

// RevokeStale revokes (force-disconnects) every subscriber whose generation is
// NOT keepGen — the generation a subscribe/unsubscribe just announced as the
// committed-current epoch. It is `!= keepGen`, not `< keepGen`, on purpose:
// generation comes from nextval() called BEFORE the catalog write, so a lower
// generation can commit AFTER a higher one; an ordering test would leave the
// higher-generation socket alive after a lower generation became current. Only
// the exact announced generation survives; every other epoch is disconnected
// (round 39 batch-2 gen-ordering audit, supersedes the `< minGen` form).
func (h *Hub) RevokeStale(queryID string, keepGen int64) {
	n := 0
	for _, s := range h.snapshot(queryID) {
		if s.generation != keepGen {
			s.Revoke()
			n++
		}
	}
	if n > 0 {
		log.Info().Str("query_id", queryID).Int64("keep_gen", keepGen).Int("revoked", n).
			Msg("Hub.RevokeStale: revoked connections not of the announced generation")
	}
}

// BroadcastGen delivers a message to subscribers of EXACTLY generation `gen`,
// skipping any that has been revoked. It is the ONLY fan-out path, used for both
// live-query deltas (the extension stamps the shmem entry's generation into
// every NOTIFY, so an old-epoch connection's generation will not match a
// new-epoch delta — round 39 batch-2 F-ORDER) and proxy-originated events
// (presence, client broadcast — F2: a stale connection never receives a current
// peer's event). Generation matching, not message ordering, is the data
// boundary; RevokeStale only adds liveness (disconnecting stale connections so
// they reconnect at the new generation).
func (h *Hub) BroadcastGen(queryID, payload string, gen int64) {
	for _, s := range h.snapshot(queryID) {
		if s.generation != gen || s.revoked() {
			continue
		}
		deliver(queryID, s, payload)
	}
}

// ── Presence ────────────────────────────────────────────────────────────

// PresenceJoin registers a client and broadcasts a join event to its generation.
func (h *Hub) PresenceJoin(channel, clientID string, state json.RawMessage, gen int64) {
	h.pmu.Lock()
	if h.presence[channel] == nil {
		h.presence[channel] = make(map[string]presenceEntry)
	}
	h.presence[channel][clientID] = presenceEntry{state: state, gen: gen}
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type": "presence_join", "channel": channel, "client_id": clientID,
		"state": json.RawMessage(state),
	})
	h.BroadcastGen(channel, string(event), gen)
}

// PresenceLeave removes a client and broadcasts a leave event to its generation.
func (h *Hub) PresenceLeave(channel, clientID string, gen int64) {
	h.pmu.Lock()
	if m := h.presence[channel]; m != nil {
		delete(m, clientID)
		if len(m) == 0 {
			delete(h.presence, channel)
		}
	}
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type": "presence_leave", "channel": channel, "client_id": clientID,
	})
	h.BroadcastGen(channel, string(event), gen)
}

// PresenceUpdate updates a client's state and broadcasts it to its generation.
func (h *Hub) PresenceUpdate(channel, clientID string, state json.RawMessage, gen int64) {
	h.pmu.Lock()
	if h.presence[channel] == nil {
		h.presence[channel] = make(map[string]presenceEntry)
	}
	h.presence[channel][clientID] = presenceEntry{state: state, gen: gen}
	h.pmu.Unlock()

	event, _ := json.Marshal(map[string]any{
		"type": "presence_state", "channel": channel, "client_id": clientID,
		"state": json.RawMessage(state),
	})
	h.BroadcastGen(channel, string(event), gen)
}

// PresenceList returns the presence state for a channel, restricted to entries
// written by connections of generation `gen`. A reader authorized for the
// current epoch must never see presence written under a different one (the
// presence map outlives a connection's revocation by a window, and under the
// gen-ordering race a stale-generation socket may not be revoked at all), so the
// caller passes the channel's current committed generation and gets only that
// epoch's rows (round 39 batch-2 gen-ordering audit).
func (h *Hub) PresenceList(channel string, gen int64) map[string]json.RawMessage {
	h.pmu.RLock()
	defer h.pmu.RUnlock()

	m := h.presence[channel]
	result := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		if v.gen == gen {
			result[k] = v.state
		}
	}
	return result
}
