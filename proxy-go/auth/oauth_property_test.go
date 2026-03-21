package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"pgregory.net/rapid"
)

// ---------------------------------------------------------------------------
// Generator helpers
// ---------------------------------------------------------------------------

// genEmailForOAuth generates a plausible email address composed of safe
// ASCII characters only (no characters that would break base64url encoding
// of the containing JSON).
func genEmailForOAuth(t *rapid.T, label string) string {
	user := rapid.StringMatching(`[a-z]{1,12}`).Draw(t, label+"_user")
	domain := rapid.StringMatching(`[a-z]{2,8}`).Draw(t, label+"_domain")
	tld := rapid.SampledFrom([]string{"com", "org", "net", "io", "dev"}).Draw(t, label+"_tld")
	return user + "@" + domain + "." + tld
}

// buildTestJWT constructs a three-part JWT with the given claims map.
// The signature segment is a dummy value — extractEmailFromJWT does not
// verify signatures, so this is sufficient for property testing.
func buildTestJWT(claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payloadBytes, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(payloadBytes)
	sig := base64.RawURLEncoding.EncodeToString([]byte("testsig"))
	return fmt.Sprintf("%s.%s.%s", header, payload, sig)
}

// ---------------------------------------------------------------------------
// Property 1: Round-trip — valid JWT with email claim returns that email
// ---------------------------------------------------------------------------

// TestProperty_ExtractEmailFromJWT_RoundTrip verifies that constructing a
// JWT whose payload contains an "email" claim, then calling
// extractEmailFromJWT, returns exactly that email string.
func TestProperty_ExtractEmailFromJWT_RoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		email := genEmailForOAuth(t, "email")

		token := buildTestJWT(map[string]any{
			"sub":   "user-abc",
			"email": email,
			"exp":   9999999999,
		})

		got, err := extractEmailFromJWT(token)
		if err != nil {
			t.Fatalf(
				"extractEmailFromJWT returned unexpected error for valid token: email=%q err=%v",
				email, err,
			)
		}

		if got != email {
			t.Fatalf(
				"round-trip email mismatch:\n  got:  %q\n  want: %q",
				got, email,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 2: Preserves email character-by-character
// ---------------------------------------------------------------------------

// TestProperty_ExtractEmailFromJWT_PreservesEmail verifies that every
// character in the original email is present, in order, in the extracted
// email — i.e. the extraction is a faithful identity transform for valid
// ASCII emails encoded in the JWT payload.
func TestProperty_ExtractEmailFromJWT_PreservesEmail(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		email := genEmailForOAuth(t, "email")

		token := buildTestJWT(map[string]any{
			"email": email,
		})

		got, err := extractEmailFromJWT(token)
		if err != nil {
			t.Fatalf("unexpected error: email=%q err=%v", email, err)
		}

		if len(got) != len(email) {
			t.Fatalf(
				"extracted email length differs: got %d chars %q, want %d chars %q",
				len(got), got, len(email), email,
			)
		}

		for i := range email {
			if got[i] != email[i] {
				t.Fatalf(
					"character mismatch at position %d: got %q, want %q (email=%q extracted=%q)",
					i, got[i], email[i], email, got,
				)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Property 3: Missing email claim returns error
// ---------------------------------------------------------------------------

// TestProperty_ExtractEmailFromJWT_MissingEmail verifies that a JWT whose
// payload contains no "email" field always causes extractEmailFromJWT to
// return a non-nil error.
func TestProperty_ExtractEmailFromJWT_MissingEmail(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Use a random sub to prevent any degenerate all-same-token scenario.
		sub := rapid.StringMatching(`[a-z0-9]{4,16}`).Draw(t, "sub")

		token := buildTestJWT(map[string]any{
			"sub": sub,
			// deliberately no "email" claim
		})

		_, err := extractEmailFromJWT(token)
		if err == nil {
			t.Fatalf(
				"expected error for JWT without email claim, got nil (sub=%q)", sub,
			)
		}
	})
}

// ---------------------------------------------------------------------------
// Property 4: Invalid JWT formats return error
// ---------------------------------------------------------------------------

// TestProperty_ExtractEmailFromJWT_InvalidFormat verifies that strings
// which are not valid three-segment JWTs (zero dots, one dot, three or
// more dots) always cause extractEmailFromJWT to return an error.
func TestProperty_ExtractEmailFromJWT_InvalidFormat(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate a base string containing no dots so we can control dot count.
		base := rapid.StringMatching(`[A-Za-z0-9+/]{1,30}`).Draw(t, "base")

		// Pick an invalid number of segments: 0 dots, 1 dot, or 4+ dots.
		// (A valid JWT has exactly 2 dots = 3 segments.)
		dotCount := rapid.SampledFrom([]int{0, 1, 4, 5}).Draw(t, "dots")

		var token string
		if dotCount == 0 {
			token = base
		} else {
			parts := make([]string, dotCount+1)
			for i := range parts {
				parts[i] = base
			}
			token = strings.Join(parts, ".")
		}

		_, err := extractEmailFromJWT(token)
		if err == nil {
			t.Fatalf(
				"expected error for token with %d dot(s) (not a 3-segment JWT): token=%q",
				dotCount, token,
			)
		}
	})
}
