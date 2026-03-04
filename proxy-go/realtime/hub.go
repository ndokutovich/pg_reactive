package realtime

import "sync"

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
}

// NewHub creates an empty Hub.
func NewHub() *Hub {
	return &Hub{subs: make(map[string][]chan string)}
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
	for _, ch := range snap {
		select {
		case ch <- payload:
		default:
			// subscriber buffer full — message dropped for this subscriber only
		}
	}
}
