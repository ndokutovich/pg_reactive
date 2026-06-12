package realtime

import (
	"testing"
	"time"
)

// Round 39 batch-2 F1/F2 (HIGH): authorization is bound to the subscription
// GENERATION, not re-checked per delta against mutable audience. A subscribe or
// unsubscribe bumps the generation; the proxy calls RevokeStale to disconnect
// every connection older than the new generation IMMEDIATELY (before any delta
// of the new epoch), and every proxy-originated event (presence, client
// broadcast) is routed generation-aware so a stale connection can never receive
// a newer generation's data.

// RevokeStale must revoke connections bound to an older generation and leave
// current-generation connections intact — this is the immediate-revocation that
// closes F1 (delta of new audience) and F2 (presence/broadcast bypass).
func TestRevokeStale_RevokesOlderGenerationOnly(t *testing.T) {
	h := NewHub()
	const qid = "q"

	old := h.Subscribe(qid, 4, 1) // connected while generation was 1
	cur := h.Subscribe(qid, 4, 2) // connected after the re-registration (gen 2)

	// A subscribe/unsubscribe announced generation 2 → revoke everything < 2.
	h.RevokeStale(qid, 2)

	select {
	case <-old.revoke:
		// expected: stale generation revoked
	case <-time.After(100 * time.Millisecond):
		t.Fatal("older-generation subscriber was NOT revoked on re-registration")
	}
	if cur.revoked() {
		t.Fatal("current-generation subscriber must NOT be revoked")
	}
}

// F-ORDER: a delta carries the generation of the shmem entry it was computed
// from. A delta produced from a re-registered (new-epoch) query is stamped with
// the NEW generation, so it must reach a connection bound to that generation but
// NOT one from the old epoch — regardless of message ordering or whether the old
// connection has been revoked yet. This is the boundary that closes the
// non-transactional shmem window the revoke-on-resubscribe ordering could not.
func TestBroadcastGen_NewEpochDeltaSkipsOldGeneration(t *testing.T) {
	h := NewHub()
	const qid = "q2"

	old := h.Subscribe(qid, 4, 1) // authorized while query was public, gen 1
	cur := h.Subscribe(qid, 4, 2) // authorized after re-registration, gen 2

	// A delta computed from the gen-2 (e.g. tenant-B) query, stamped gen 2.
	// The old gen-1 connection must not see it even though it has NOT been
	// revoked (the resubscribed notice may not have been processed yet).
	h.BroadcastGen(qid, `{"secret":true}`, 2)

	select {
	case got := <-old.ch:
		t.Fatalf("old-epoch (gen-1) connection must NOT receive a gen-2 delta, got: %s", got)
	default:
	}
	select {
	case got := <-cur.ch:
		if got != `{"secret":true}` {
			t.Fatalf("current-generation subscriber got wrong payload: %s", got)
		}
	default:
		t.Fatal("current-generation subscriber did NOT receive the delta")
	}
}

// A steady-state delta (no re-registration) is stamped with the same generation
// every connection bound to, so it reaches them all and revokes nobody.
func TestBroadcastGen_SteadyStateReachesAllSameGeneration(t *testing.T) {
	h := NewHub()
	const qid = "q3"
	a := h.Subscribe(qid, 4, 5)
	b := h.Subscribe(qid, 4, 5)

	h.BroadcastGen(qid, `{"x":1}`, 5)

	for _, s := range []*subscriber{a, b} {
		select {
		case <-s.revoke:
			t.Fatal("steady-state delta wrongly revoked a subscriber")
		default:
		}
		select {
		case got := <-s.ch:
			if got != `{"x":1}` {
				t.Fatalf("wrong payload: %s", got)
			}
		default:
			t.Fatal("subscriber did not receive a steady-state delta")
		}
	}
}

// A revoked connection is skipped even when the delta's generation matches —
// belt-and-suspenders with RevokeStale's liveness disconnect.
func TestBroadcastGen_SkipsRevokedEvenOnGenerationMatch(t *testing.T) {
	h := NewHub()
	const qid = "q3b"
	s := h.Subscribe(qid, 4, 7)
	s.Revoke()

	h.BroadcastGen(qid, `{"x":1}`, 7)

	select {
	case got := <-s.ch:
		t.Fatalf("revoked connection must receive nothing, got: %s", got)
	default:
	}
}

// F2: presence/broadcast go through BroadcastGen, NOT BroadcastDelta, and must
// reach ONLY subscribers of the sender's generation. A connection from an older
// generation must never receive a current-generation peer's event — even before
// any PG delta has had a chance to revoke it.
func TestBroadcastGen_DeliversOnlyToMatchingGeneration(t *testing.T) {
	h := NewHub()
	const qid = "q4"

	stale := h.Subscribe(qid, 4, 1) // e.g. anon connected while public
	fresh := h.Subscribe(qid, 4, 2) // authorized peer after audience change

	// A gen-2 peer emits a broadcast/presence event.
	h.BroadcastGen(qid, `{"presence":"secret"}`, 2)

	select {
	case got := <-stale.ch:
		t.Fatalf("older-generation subscriber must NOT receive a gen-2 event, got: %s", got)
	default:
	}
	select {
	case got := <-fresh.ch:
		if got != `{"presence":"secret"}` {
			t.Fatalf("matching-generation subscriber got wrong payload: %s", got)
		}
	default:
		t.Fatal("matching-generation subscriber did NOT receive the event")
	}
}

// Generation is an OPAQUE epoch, not a commit-ordered counter: nextval() runs
// before the catalog write, so a LOWER generation can commit AFTER a higher one
// (a stalled re-subscribe committing last). RevokeStale must therefore revoke
// every socket whose generation != the announced one — not only lower ones —
// or a high-generation socket survives when a lower generation is announced
// last, and keeps reading / writing presence for an epoch that is no longer
// current (round 39 batch-2 gen-ordering audit, HIGH).
func TestRevokeStale_RevokesAnyNonMatchingGeneration(t *testing.T) {
	h := NewHub()
	const qid = "q-epoch"
	high := h.Subscribe(qid, 4, 6) // bound to a HIGHER generation
	keep := h.Subscribe(qid, 4, 5) // bound to the generation about to be announced

	// The gen-5 re-subscribe committed last (its nextval was lower, but it
	// committed after the gen-6 one). Everything not of gen 5 must be revoked.
	h.RevokeStale(qid, 5)

	select {
	case <-high.revoke:
		// expected: the higher-generation socket is revoked too
	case <-time.After(100 * time.Millisecond):
		t.Fatal("higher-generation socket was NOT revoked when a lower generation was announced last")
	}
	if keep.revoked() {
		t.Fatal("the announced-generation socket must NOT be revoked")
	}
}

// Revoke is idempotent and concurrency-safe: two re-registrations that both
// find a subscriber stale must not double-close its revoke channel.
func TestRevokeStale_IsIdempotent(t *testing.T) {
	h := NewHub()
	const qid = "q5"
	s := h.Subscribe(qid, 4, 1)

	h.RevokeStale(qid, 3)
	h.RevokeStale(qid, 4) // must not panic on double revoke

	select {
	case <-s.revoke:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("subscriber not revoked")
	}
}
