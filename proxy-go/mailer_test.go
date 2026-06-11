package main

// Mailer context propagation — upgrade-c-to-a mailer Gap 3.
// A slow or dead SMTP server must not pin a handler goroutine: Send takes
// a context.Context and the retry loop aborts as soon as it is cancelled,
// instead of sleeping through the full exponential backoff.

import (
	"context"
	"errors"
	"testing"
	"time"
)

// failingDialer always fails, counting attempts — drives the retry loop.
type failingDialer struct {
	attempts int
}

func (d *failingDialer) send(_ context.Context, _, _, _, _ string) error {
	d.attempts++
	return errors.New("boom")
}

func TestSendWithRetryStopsOnCancelledContext(t *testing.T) {
	d := &failingDialer{}
	m := &Mailer{from: "noreply@test", dialer: d}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled — backoff must not sleep at all

	start := time.Now()
	err := m.Send(ctx, "user@test", "subj", "<p>body</p>")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error from cancelled context, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled in error chain, got: %v", err)
	}
	// Full backoff is 1s+2s; a cancelled ctx must return immediately.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Send took %v with cancelled ctx — backoff ignored cancellation", elapsed)
	}
	if d.attempts > 1 {
		t.Fatalf("expected at most 1 attempt with cancelled ctx, got %d", d.attempts)
	}
}

func TestSendWithRetryDeadlineCutsBackoffShort(t *testing.T) {
	d := &failingDialer{}
	m := &Mailer{from: "noreply@test", dialer: d}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := m.Send(ctx, "user@test", "subj", "<p>body</p>")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// First attempt fails instantly, backoff (1s) exceeds the 300ms budget:
	// the deadline must cut the wait short instead of sleeping the full 1s.
	if elapsed > 800*time.Millisecond {
		t.Fatalf("Send took %v — deadline did not interrupt backoff", elapsed)
	}
	if d.attempts != 1 {
		t.Fatalf("expected exactly 1 attempt before deadline, got %d", d.attempts)
	}
}

func TestSendRetriesThenSucceeds(t *testing.T) {
	if testing.Short() {
		t.Skip("multi-second backoff")
	}
	d := &flakyDialer{failuresLeft: 1}
	m := &Mailer{from: "noreply@test", dialer: d}

	if err := m.Send(context.Background(), "user@test", "subj", "<p>body</p>"); err != nil {
		t.Fatalf("expected retry to succeed, got: %v", err)
	}
	if d.attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", d.attempts)
	}
}

type flakyDialer struct {
	failuresLeft int
	attempts     int
}

func (d *flakyDialer) send(_ context.Context, _, _, _, _ string) error {
	d.attempts++
	if d.failuresLeft > 0 {
		d.failuresLeft--
		return errors.New("transient")
	}
	return nil
}
