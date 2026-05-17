package middleware

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// hijackEchoHandler simulates the websocket upgrade flow: it hijacks the
// connection, writes a 101 line, and then echoes whatever the client sends
// until the connection closes. The hijack alone is what consumes a slot —
// the body just keeps the conn open long enough to verify the cap holds.
func hijackEchoHandler(t *testing.T, releaseCh <-chan struct{}) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Errorf("ResponseWriter does not implement Hijacker")
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		conn, brw, err := hj.Hijack()
		if err != nil {
			// Limiter rejected the hijack — response has already been written.
			return
		}
		defer conn.Close()
		// Minimal "upgrade" reply so the client can detect the hijack happened.
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\n\r\n")
		_ = brw.Flush()
		// Block until the test signals release, then close.
		<-releaseCh
	}
}

// openConn dials the test server, sends a GET with X-Forwarded-For=ip, and
// returns the underlying TCP conn + the parsed first response line. The
// caller MUST eventually close the returned conn (or call signal-close on
// the release channel passed to the handler).
func openConn(t *testing.T, srv *httptest.Server, path, ip string) (net.Conn, string) {
	t.Helper()
	u := strings.TrimPrefix(srv.URL, "http://")
	conn, err := net.Dial("tcp", u)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nX-Forwarded-For: %s\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n", path, u, ip)
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	return conn, strings.TrimRight(line, "\r\n")
}

func TestWSConnLimiter_AllowsUpToCap(t *testing.T) {
	const cap = 3
	limiter := NewWSConnLimiter(cap)
	release := make(chan struct{}, cap)
	srv := httptest.NewServer(limiter.Middleware(hijackEchoHandler(t, release)))
	defer srv.Close()

	conns := make([]net.Conn, 0, cap)
	for i := 0; i < cap; i++ {
		c, status := openConn(t, srv, "/ws/x", "10.0.0.1")
		if !strings.Contains(status, "101") {
			t.Fatalf("connection %d: status = %q, want 101", i+1, status)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		_ = c.Close()
	}
	// Release the handlers so their deferred conn.Close() runs and the
	// limiter sees the decrement.
	for i := 0; i < cap; i++ {
		release <- struct{}{}
	}
	waitForCount(t, limiter, "10.0.0.1", 0)
}

func TestWSConnLimiter_RejectsOverCap(t *testing.T) {
	const cap = 2
	limiter := NewWSConnLimiter(cap)
	release := make(chan struct{}, cap+1)
	srv := httptest.NewServer(limiter.Middleware(hijackEchoHandler(t, release)))
	defer srv.Close()
	defer func() {
		for i := 0; i < cap+1; i++ {
			select {
			case release <- struct{}{}:
			default:
			}
		}
	}()

	var keepOpen []net.Conn
	for i := 0; i < cap; i++ {
		c, status := openConn(t, srv, "/ws/x", "10.0.0.2")
		if !strings.Contains(status, "101") {
			t.Fatalf("setup conn %d: status = %q", i+1, status)
		}
		keepOpen = append(keepOpen, c)
	}
	// (N+1)th must be rejected with 429.
	c, status := openConn(t, srv, "/ws/x", "10.0.0.2")
	defer c.Close()
	if !strings.Contains(status, "429") {
		t.Fatalf("over-cap conn: status = %q, want 429", status)
	}
	for _, c := range keepOpen {
		_ = c.Close()
	}
}

func TestWSConnLimiter_CloseDecrementsCounter(t *testing.T) {
	const cap = 1
	limiter := NewWSConnLimiter(cap)
	release := make(chan struct{}, 4)
	srv := httptest.NewServer(limiter.Middleware(hijackEchoHandler(t, release)))
	defer srv.Close()
	defer close(release)

	c1, status := openConn(t, srv, "/ws/x", "10.0.0.3")
	if !strings.Contains(status, "101") {
		t.Fatalf("conn 1: status = %q", status)
	}
	// Second attempt while c1 is open: rejected.
	c2, status2 := openConn(t, srv, "/ws/x", "10.0.0.3")
	if !strings.Contains(status2, "429") {
		t.Fatalf("conn 2 (while c1 open): status = %q, want 429", status2)
	}
	_ = c2.Close()

	// Close c1 — slot should be released and the next attempt should succeed.
	_ = c1.Close()
	release <- struct{}{} // unblock the handler so it exits and runs deferred Close
	waitForCount(t, limiter, "10.0.0.3", 0)

	c3, status3 := openConn(t, srv, "/ws/x", "10.0.0.3")
	defer c3.Close()
	if !strings.Contains(status3, "101") {
		t.Fatalf("conn 3 (after release): status = %q, want 101", status3)
	}
}

func TestWSConnLimiter_TracksIPsIndependently(t *testing.T) {
	const cap = 1
	limiter := NewWSConnLimiter(cap)
	release := make(chan struct{}, 4)
	srv := httptest.NewServer(limiter.Middleware(hijackEchoHandler(t, release)))
	defer srv.Close()
	defer func() {
		for i := 0; i < 4; i++ {
			select {
			case release <- struct{}{}:
			default:
			}
		}
	}()

	cA, statusA := openConn(t, srv, "/ws/x", "10.0.0.4")
	defer cA.Close()
	if !strings.Contains(statusA, "101") {
		t.Fatalf("IP A first conn: status = %q", statusA)
	}
	// Different IP — its own bucket, must succeed even though A is at cap.
	cB, statusB := openConn(t, srv, "/ws/x", "10.0.0.5")
	defer cB.Close()
	if !strings.Contains(statusB, "101") {
		t.Fatalf("IP B first conn: status = %q, want 101 (independent bucket)", statusB)
	}
	// And A's second is still rejected.
	cA2, statusA2 := openConn(t, srv, "/ws/x", "10.0.0.4")
	defer cA2.Close()
	if !strings.Contains(statusA2, "429") {
		t.Fatalf("IP A second conn: status = %q, want 429", statusA2)
	}
}

func TestWSConnLimiter_PrechecksBeforeHijack(t *testing.T) {
	// When the cap is already at zero (or the precheck rejects), the handler
	// should never be invoked — guarantees a rejected upgrade doesn't even
	// hit the goja runtime.
	limiter := NewWSConnLimiter(1)
	// Seed counter directly.
	limiter.mu.Lock()
	limiter.counts["10.0.0.6"] = 1
	limiter.mu.Unlock()

	var handlerCalls int
	var mu sync.Mutex
	h := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		handlerCalls++
		mu.Unlock()
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ws/x", nil)
	req.Header.Set("X-Forwarded-For", "10.0.0.6")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", rec.Code)
	}
	mu.Lock()
	calls := handlerCalls
	mu.Unlock()
	if calls != 0 {
		t.Errorf("handler invoked %d times despite precheck rejection", calls)
	}
}

func TestWSConnLimiter_ZeroDisablesLimit(t *testing.T) {
	limiter := NewWSConnLimiter(0)
	// Any handler — passthrough should preserve the response verbatim.
	h := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	for i := 0; i < 100; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/ws/x", nil)
		req.Header.Set("X-Forwarded-For", "10.0.0.7")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("iteration %d: status = %d, want 200 (limit disabled)", i, rec.Code)
		}
	}
}

func TestWSClientIP_XFFFirstValue(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	r.RemoteAddr = "127.0.0.1:5555"
	if got := wsClientIP(r); got != "1.2.3.4" {
		t.Errorf("wsClientIP = %q, want 1.2.3.4", got)
	}
}

func TestWSClientIP_FallsBackToRemoteAddr(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.5:5555"
	if got := wsClientIP(r); got != "203.0.113.5" {
		t.Errorf("wsClientIP = %q, want 203.0.113.5", got)
	}
}

// waitForCount polls the limiter until the per-IP count reaches the target
// or the deadline expires. Eliminates timing flake from goroutine teardown.
func waitForCount(t *testing.T, l *WSConnLimiter, ip string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if l.Count(ip) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("count for %s = %d, want %d (timeout)", ip, l.Count(ip), want)
}
