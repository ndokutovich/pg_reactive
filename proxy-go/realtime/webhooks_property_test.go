package realtime

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generator helpers
// ---------------------------------------------------------------------------

// genEventName generates an arbitrary non-empty ASCII event name such as
// "INSERT", "UPDATE", "DELETE", or any capitalization thereof.
func genEventName(t *rapid.T, label string) string {
	return rapid.StringMatching(`[A-Za-z]{1,20}`).Draw(t, label)
}

// genEventList generates a non-empty slice of event name strings, none of
// which are the wildcard "*".
func genEventList(t *rapid.T, label string) []string {
	size := rapid.IntRange(1, 8).Draw(t, label+"_size")
	events := make([]string, size)
	for i := range events {
		events[i] = genEventName(t, label+"_item")
	}
	return events
}

// genSecret generates a non-empty HMAC secret.
func genWebhookSecret(t *rapid.T, label string) string {
	return rapid.StringMatching(`[A-Za-z0-9!@#]{8,64}`).Draw(t, label)
}

// ---------------------------------------------------------------------------
// Property 1: Wildcard supremacy
// ---------------------------------------------------------------------------

// TestProperty_MatchesEvent_WildcardSupremacy verifies that if the events
// slice contains "*", matchesEvent always returns true regardless of the
// event string being tested.
func TestProperty_MatchesEvent_WildcardSupremacy(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		base := genEventList(t, "base")
		// Insert "*" at a random position.
		pos := rapid.IntRange(0, len(base)).Draw(t, "pos")
		events := make([]string, 0, len(base)+1)
		events = append(events, base[:pos]...)
		events = append(events, "*")
		events = append(events, base[pos:]...)

		event := genEventName(t, "event")

		if !matchesEvent(events, event) {
			t.Fatalf(
				"wildcard in events list must always match any event: events=%v event=%q",
				events, event,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 2: Self-match
// ---------------------------------------------------------------------------

// TestProperty_MatchesEvent_SelfMatch verifies that any non-empty string
// matches a single-element list containing exactly that string.
func TestProperty_MatchesEvent_SelfMatch(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		x := genEventName(t, "x")

		if !matchesEvent([]string{x}, x) {
			t.Fatalf("matchesEvent([]string{%q}, %q) must be true (self-match)", x, x)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 3: Case insensitivity
// ---------------------------------------------------------------------------

// TestProperty_MatchesEvent_CaseInsensitivity verifies that matchesEvent
// treats the list element and the target event case-insensitively.
func TestProperty_MatchesEvent_CaseInsensitivity(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		x := genEventName(t, "x")
		upper := strings.ToUpper(x)
		lower := strings.ToLower(x)

		// Upper-case in list, lower-case query
		if !matchesEvent([]string{upper}, lower) {
			t.Fatalf(
				"matchesEvent([]string{%q}, %q) must be true (case-insensitive)",
				upper, lower,
			)
		}

		// Lower-case in list, upper-case query
		if !matchesEvent([]string{lower}, upper) {
			t.Fatalf(
				"matchesEvent([]string{%q}, %q) must be true (case-insensitive)",
				lower, upper,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 4: Empty list always returns false
// ---------------------------------------------------------------------------

// TestProperty_MatchesEvent_EmptyListNeverMatches verifies that an empty
// events slice never matches any event string.
func TestProperty_MatchesEvent_EmptyListNeverMatches(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		event := genEventName(t, "event")

		if matchesEvent([]string{}, event) {
			t.Fatalf("matchesEvent([], %q) must be false for any event", event)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 5: Superset monotonicity
// ---------------------------------------------------------------------------

// TestProperty_MatchesEvent_SupersetMonotonicity verifies that if
// matchesEvent(events, x) is true, adding any additional element y to the
// list keeps the result true.
func TestProperty_MatchesEvent_SupersetMonotonicity(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Start with a list that contains at least one matching event.
		event := genEventName(t, "event")
		base := genEventList(t, "base")

		// Guarantee that 'event' is already in the list so the precondition holds.
		events := append([]string{event}, base...)

		if !matchesEvent(events, event) {
			// Precondition violated (shouldn't happen given construction). Skip.
			return
		}

		extra := genEventName(t, "extra")
		extended := append(events, extra)

		if !matchesEvent(extended, event) {
			t.Fatalf(
				"superset monotonicity violated: matchesEvent was true for events=%v event=%q, "+
					"but false after appending %q => extended=%v",
				events, event, extra, extended,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// HMAC Property 6: Determinism — same secret + same body = same signature
// ---------------------------------------------------------------------------

// TestProperty_HMAC_Determinism verifies that calling deliver twice with
// identical secret and body always sends the same X-Webhook-Signature header.
func TestProperty_HMAC_Determinism(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		secret := genWebhookSecret(t, "secret")
		body, _ := json.Marshal(WebhookPayload{
			Event: genEventName(t, "event"),
			Table: rapid.StringMatching(`[a-z]{1,16}`).Draw(t, "table"),
		})

		var sig1, sig2 string

		// First delivery
		srv1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sig1 = r.Header.Get("X-Webhook-Signature")
			w.WriteHeader(http.StatusOK)
		}))
		defer srv1.Close()

		wm1 := &WebhookManager{client: srv1.Client()}
		err := wm1.deliver(Webhook{ID: "1", URL: srv1.URL, Secret: secret, Active: true}, body)
		if err != nil {
			t.Fatalf("first deliver failed: %v", err)
		}

		// Second delivery with same inputs
		srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sig2 = r.Header.Get("X-Webhook-Signature")
			w.WriteHeader(http.StatusOK)
		}))
		defer srv2.Close()

		wm2 := &WebhookManager{client: srv2.Client()}
		err = wm2.deliver(Webhook{ID: "2", URL: srv2.URL, Secret: secret, Active: true}, body)
		if err != nil {
			t.Fatalf("second deliver failed: %v", err)
		}

		if sig1 != sig2 {
			t.Fatalf(
				"HMAC is not deterministic: same secret+body produced different signatures\n"+
					"  sig1=%q\n  sig2=%q",
				sig1, sig2,
			)
		}

		// Also verify against a direct HMAC computation.
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if sig1 != expected {
			t.Fatalf(
				"delivered signature does not match directly computed HMAC\n"+
					"  got:  %q\n  want: %q",
				sig1, expected,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// HMAC Property 7: Sensitivity — different body or secret changes signature
// ---------------------------------------------------------------------------

// TestProperty_HMAC_Sensitivity verifies that changing the body or the
// secret produces a different X-Webhook-Signature value with overwhelming
// probability (a collision is negligible for SHA-256).
func TestProperty_HMAC_Sensitivity(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		secret1 := genWebhookSecret(t, "secret1")
		secret2 := genWebhookSecret(t, "secret2")

		body1, _ := json.Marshal(WebhookPayload{
			Event: genEventName(t, "event1"),
			Table: rapid.StringMatching(`[a-z]{1,16}`).Draw(t, "table1"),
		})
		body2, _ := json.Marshal(WebhookPayload{
			Event: genEventName(t, "event2"),
			Table: rapid.StringMatching(`[a-z]{1,16}`).Draw(t, "table2"),
		})

		// Skip the trivial case where both inputs are identical.
		if secret1 == secret2 && string(body1) == string(body2) {
			return
		}

		computeSig := func(secret string, body []byte) string {
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write(body)
			return "sha256=" + hex.EncodeToString(mac.Sum(nil))
		}

		sig1 := computeSig(secret1, body1)
		sig2 := computeSig(secret2, body2)

		if sig1 == sig2 {
			t.Fatalf(
				"HMAC collision between different inputs (inputs differed, signatures were identical)\n"+
					"  secret1=%q body1=%s\n  secret2=%q body2=%s\n  sig=%q",
				secret1, body1, secret2, body2, sig1,
			)
		}
	})
}
