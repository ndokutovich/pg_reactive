package middleware

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sync"
)

// WSConnLimiter caps concurrent WebSocket connections per source IP.
//
// Detection model: the middleware wraps the ResponseWriter and intercepts
// Hijack() — the call every websocket upgrader makes once the handshake
// succeeds. Increment happens AT Hijack (only on successful upgrade, never on
// handshake failure / auth reject / 4xx). The returned net.Conn is wrapped so
// its Close() decrements the counter exactly once. If the handler never
// hijacks (handshake rejected, auth failure, anon-key gate, etc.) no counter
// state is touched, so failed upgrades cannot leak slots.
//
// Source IP: delegates to the package-shared realIP helper (see
// rate_limit.go) so X-Forwarded-For is honoured ONLY when the immediate
// connection comes from a configured trusted proxy. Without that gate a
// client could rotate XFF per request and bypass the cap completely
// (every spoofed IP gets its own bucket starting at zero) — this was
// flagged by codex round 21.
//
// State: in-memory map keyed by IP, mutex-guarded. This is correct for the
// all-in-one container (one proxy process). If/when we scale out, replace
// the counter with a Redis INCR/DECR so the cap is enforced across replicas.
type WSConnLimiter struct {
	maxPerIP       int
	trustedProxies []string
	mu             sync.Mutex
	counts         map[string]int
}

// NewWSConnLimiter returns a limiter that allows at most maxPerIP concurrent
// WebSocket connections from a single client IP. maxPerIP <= 0 disables the
// limit (the middleware becomes a passthrough). trustedProxies is the same
// list passed to the rate limiter — XFF/XRI headers are only honoured when
// the immediate r.RemoteAddr matches one of these IPs.
func NewWSConnLimiter(maxPerIP int, trustedProxies []string) *WSConnLimiter {
	return &WSConnLimiter{
		maxPerIP:       maxPerIP,
		trustedProxies: trustedProxies,
		counts:         make(map[string]int),
	}
}

// Middleware returns the chi-compatible handler. Wrap only routes that lead
// to a WebSocket upgrade — every request that passes through is checked
// against the cap, even though only hijacking ones consume a slot.
func (l *WSConnLimiter) Middleware(next http.Handler) http.Handler {
	if l == nil || l.maxPerIP <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := realIP(r, l.trustedProxies)

		// Optimistic precheck — reject before invoking the handler when the
		// IP is already at the cap. Avoids any work for the upgrade attempt.
		l.mu.Lock()
		if l.counts[ip] >= l.maxPerIP {
			l.mu.Unlock()
			writeWSLimitError(w)
			return
		}
		l.mu.Unlock()

		// Wrap the writer so the increment/decrement happens at Hijack time
		// only — a handler that 401s before the upgrade leaves no trace.
		hw := &wsHijackWriter{
			ResponseWriter: w,
			limiter:        l,
			ip:             ip,
		}
		next.ServeHTTP(hw, r)
	})
}

// Count returns the current open-connection count for an IP. Test helper.
func (l *WSConnLimiter) Count(ip string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.counts[ip]
}

func (l *WSConnLimiter) tryIncrement(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.counts[ip] >= l.maxPerIP {
		return false
	}
	l.counts[ip]++
	return true
}

func (l *WSConnLimiter) decrement(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.counts[ip] > 0 {
		l.counts[ip]--
	}
	if l.counts[ip] == 0 {
		delete(l.counts, ip)
	}
}

// wsHijackWriter wraps an http.ResponseWriter to intercept Hijack() — the
// signal that a websocket upgrade is about to take ownership of the
// underlying TCP connection.
type wsHijackWriter struct {
	http.ResponseWriter
	limiter *WSConnLimiter
	ip      string
}

// Hijack implements http.Hijacker. Reserves a slot atomically — if the cap
// was reached between the precheck and now (concurrent upgrade race), the
// hijack is refused with 429 semantics by returning an error to the handler.
func (h *wsHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := h.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("ws_conn_limit: underlying ResponseWriter does not support Hijack")
	}
	if !h.limiter.tryIncrement(h.ip) {
		writeWSLimitError(h.ResponseWriter)
		return nil, nil, errors.New("ws_conn_limit: per-IP cap reached")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		// Hijack itself failed — release the slot we just reserved so a
		// hijack error doesn't leak a permanent slot for this IP.
		h.limiter.decrement(h.ip)
		return nil, nil, err
	}
	return &wsTrackedConn{
		Conn:    conn,
		limiter: h.limiter,
		ip:      h.ip,
	}, brw, nil
}

// wsTrackedConn wraps the hijacked net.Conn so Close() decrements the per-IP
// counter exactly once, regardless of how many times Close is called.
type wsTrackedConn struct {
	net.Conn
	limiter *WSConnLimiter
	ip      string
	closed  sync.Once
}

func (c *wsTrackedConn) Close() error {
	err := c.Conn.Close()
	c.closed.Do(func() {
		c.limiter.decrement(c.ip)
	})
	return err
}

// writeWSLimitError emits the standard 429 response when the per-IP cap is
// reached. Kept in one place so the body matches across both the precheck
// and the hijack-time race rejection.
func writeWSLimitError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	body, _ := json.Marshal(map[string]string{
		"error": "too many concurrent websocket connections from this address",
	})
	_, _ = w.Write(body)
}
