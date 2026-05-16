package realtime

import (
	"testing"
	"time"
)

func TestRateBucket_BurstThenRateLimit(t *testing.T) {
	b := newRateBucket(10, 3) // 10/sec, burst 3

	// Burst exactly 3 should succeed back-to-back.
	for i := 0; i < 3; i++ {
		if !b.allow() {
			t.Fatalf("burst token #%d should succeed", i+1)
		}
	}
	// 4th immediately should fail — burst exhausted.
	if b.allow() {
		t.Fatal("4th immediate call should be rate-limited")
	}
}

func TestRateBucket_RefillsOverTime(t *testing.T) {
	b := newRateBucket(100, 1) // 100/sec, burst 1

	if !b.allow() {
		t.Fatal("first call must succeed (burst=1)")
	}
	if b.allow() {
		t.Fatal("second immediate call must be rate-limited")
	}

	// After ~15ms a 100/sec bucket has refilled >1 token.
	time.Sleep(15 * time.Millisecond)
	if !b.allow() {
		t.Fatal("after refill the bucket should have a token")
	}
}

func TestRateBucket_CapsAtBurst(t *testing.T) {
	b := newRateBucket(1000, 2) // 1000/sec, burst 2

	// Wait long enough that an unbounded bucket would have >>2 tokens.
	time.Sleep(50 * time.Millisecond)

	if !b.allow() {
		t.Fatal("call #1 should succeed")
	}
	if !b.allow() {
		t.Fatal("call #2 should succeed")
	}
	// Cap prevents the third — the bucket cannot accumulate above `burst`.
	if b.allow() {
		t.Fatal("third call should be rate-limited (cap enforced)")
	}
}
