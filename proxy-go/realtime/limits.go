package realtime

import (
	"sync"
	"time"
)

// Per-WebSocket-connection limits closed in audit finding F4 (2026-05).
//
// Before: gorilla/websocket.ReadMessage with no SetReadLimit + no message
// rate cap meant a single client could OOM the proxy by sending one
// gigantic frame, or peg CPU by spamming presence updates. Both
// straightforward DoS vectors.
const (
	// maxWSMessageBytes caps a single client-to-server frame. Real presence
	// payloads in our examples top out around 1 KB; a 64 KiB ceiling
	// leaves headroom for legitimate broadcast use while bounding the worst
	// case a hostile client can force the server to allocate.
	maxWSMessageBytes = 64 * 1024

	// wsMsgRate is the sustained per-connection message rate (messages /
	// second) the proxy accepts. 100 covers high-frequency presence
	// updates (~25 Hz multi-channel) with a 4x safety margin.
	wsMsgRate = 100

	// wsMsgBurst is the per-connection token-bucket capacity — short
	// spikes (e.g. the join-time presence flurry) are absorbed.
	wsMsgBurst = 20

	// wsWriteWait bounds a single server-to-client write. Without a deadline a
	// connection wedged on a slow/stuck TCP write blocks its goroutine
	// indefinitely — so a revoked socket (RevokeStale) would not observe the
	// revoke until the write returned, delaying disconnect and leaking the
	// semaphore slot. The deadline turns a stuck write into an error the send
	// loop treats as a disconnect (round 39 batch-2 F-LIVENESS).
	wsWriteWait = 10 * time.Second
)

// rateBucket is a tiny per-connection token bucket. Not allocation-free,
// but it's only consulted once per WS frame; rate-limit overhead is
// vastly cheaper than the JSON parse that follows on an allow.
type rateBucket struct {
	mu        sync.Mutex
	tokens    float64
	maxTokens float64
	refill    float64 // tokens per second
	last      time.Time
}

// newRateBucket returns a bucket initialised to `burst` tokens that
// refills at `rate` tokens/sec, capped at `burst`.
func newRateBucket(rate, burst int) *rateBucket {
	return &rateBucket{
		tokens:    float64(burst),
		maxTokens: float64(burst),
		refill:    float64(rate),
		last:      time.Now(),
	}
}

// allow consumes one token if the bucket has spare capacity. Returns
// false when the caller has exceeded the rate.
func (b *rateBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.last).Seconds()
	b.last = now

	b.tokens += elapsed * b.refill
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
