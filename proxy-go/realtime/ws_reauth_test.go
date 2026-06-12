package realtime

import (
	"testing"
	"time"
)

// Round 39 F1 (HIGH): a live-query delta must be re-authorized at delivery, not
// only at handshake. BroadcastDelta must revoke (disconnect) a subscriber whose
// authorize closure no longer satisfies the CURRENT audience and deliver it
// nothing, while still delivering to subscribers that remain authorized.

func TestBroadcastDelta_RevokesUnauthorizedSubscriber(t *testing.T) {
	h := NewHub()
	const qid = "q"

	// Authorized only for the public (empty) audience — models a connection
	// authorized while the query was public.
	pubOnly := h.Subscribe(qid, 4, func(audience string) bool { return audience == "" })
	// Authorized for any audience — models service_role.
	always := h.Subscribe(qid, 4, func(string) bool { return true })

	// Audience flips to private. pubOnly must be revoked and get nothing;
	// always must still receive the delta.
	h.BroadcastDelta(qid, `{"secret":true}`, `{"sub":"victim"}`)

	select {
	case <-pubOnly.revoke:
		// expected: revoked
	case <-time.After(100 * time.Millisecond):
		t.Fatal("public-only subscriber was NOT revoked on audience change")
	}
	select {
	case <-pubOnly.ch:
		t.Fatal("revoked subscriber must NOT receive the post-change delta")
	default:
	}
	select {
	case got := <-always.ch:
		if got != `{"secret":true}` {
			t.Fatalf("authorized subscriber got wrong payload: %s", got)
		}
	default:
		t.Fatal("authorized subscriber did NOT receive the delta")
	}
}

func TestBroadcastDelta_PublicReachesAllWithoutRevocation(t *testing.T) {
	h := NewHub()
	const qid = "q2"
	s := h.Subscribe(qid, 4, func(audience string) bool { return audience == "" })

	h.BroadcastDelta(qid, `{"x":1}`, "") // empty audience = public

	select {
	case <-s.revoke:
		t.Fatal("public subscriber wrongly revoked on a public delta")
	default:
	}
	select {
	case got := <-s.ch:
		if got != `{"x":1}` {
			t.Fatalf("wrong payload: %s", got)
		}
	default:
		t.Fatal("public subscriber did not receive a public delta")
	}
}

// Revoke is idempotent and concurrency-safe: two deltas that both find a
// subscriber unauthorized must not double-close its revoke channel.
func TestBroadcastDelta_RevokeIsIdempotent(t *testing.T) {
	h := NewHub()
	const qid = "q3"
	s := h.Subscribe(qid, 4, func(string) bool { return false })
	h.BroadcastDelta(qid, `{"a":1}`, `{"sub":"x"}`)
	h.BroadcastDelta(qid, `{"a":2}`, `{"sub":"x"}`) // must not panic on double revoke
	select {
	case <-s.revoke:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("subscriber not revoked")
	}
}
