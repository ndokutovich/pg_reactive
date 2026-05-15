package realtime

import "testing"

// Regression for finding F1 (security audit 2026-05): audience-bound
// subscriptions must match JWT claims at WS-connect time. The matcher is
// the kernel of the authz model — every kind of bug must surface here
// rather than at the slower e2e layer.

func TestClaimsSatisfyAudience_EmptyAudienceAlwaysPasses(t *testing.T) {
	if !claimsSatisfyAudience("", `{"sub":"42"}`) {
		t.Fatal("empty audience is public — must pass")
	}
	if !claimsSatisfyAudience("", "") {
		t.Fatal("empty audience must pass even without claims")
	}
}

func TestClaimsSatisfyAudience_AllKeysMustMatch(t *testing.T) {
	cases := []struct {
		name     string
		audience string
		claims   string
		want     bool
	}{
		{
			name:     "single key match",
			audience: `{"sub":"42"}`,
			claims:   `{"sub":"42","role":"authenticated"}`,
			want:     true,
		},
		{
			name:     "single key mismatch",
			audience: `{"sub":"42"}`,
			claims:   `{"sub":"99"}`,
			want:     false,
		},
		{
			name:     "two keys both match",
			audience: `{"sub":"42","role":"authenticated"}`,
			claims:   `{"sub":"42","role":"authenticated","email":"a@b"}`,
			want:     true,
		},
		{
			name:     "two keys one mismatch",
			audience: `{"sub":"42","role":"admin"}`,
			claims:   `{"sub":"42","role":"authenticated"}`,
			want:     false,
		},
		{
			name:     "missing claim",
			audience: `{"org_id":"acme"}`,
			claims:   `{"sub":"42"}`,
			want:     false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := claimsSatisfyAudience(tc.audience, tc.claims)
			if got != tc.want {
				t.Fatalf("audience=%s claims=%s: got %v want %v",
					tc.audience, tc.claims, got, tc.want)
			}
		})
	}
}

func TestClaimsSatisfyAudience_NumberVsString(t *testing.T) {
	// {"sub":42} and {"sub":"42"} are NOT equal — JWT issuers must pick a
	// consistent encoding. Document the gotcha by asserting it.
	if claimsSatisfyAudience(`{"sub":42}`, `{"sub":"42"}`) {
		t.Fatal("number 42 must not match string \"42\"")
	}
	if claimsSatisfyAudience(`{"sub":"42"}`, `{"sub":42}`) {
		t.Fatal("string \"42\" must not match number 42")
	}
}

func TestClaimsSatisfyAudience_FailsClosedOnMalformed(t *testing.T) {
	if claimsSatisfyAudience(`{`, `{"sub":"42"}`) {
		t.Fatal("malformed audience must fail closed")
	}
	if claimsSatisfyAudience(`{"sub":"42"}`, `{`) {
		t.Fatal("malformed claims must fail closed")
	}
	if claimsSatisfyAudience(`{"sub":"42"}`, ``) {
		t.Fatal("empty claims must fail when audience is set")
	}
}

func TestClaimsSatisfyAudience_NestedValuesByteCompare(t *testing.T) {
	// Same shape, same content -> match. Different ordering inside a nested
	// object MAY break match — that's acceptable because JWT libraries emit
	// stable output. The contract is byte-equality after whitespace trim.
	a := `{"app":{"role":"admin"}}`
	c := `{"app":{"role":"admin"},"sub":"42"}`
	if !claimsSatisfyAudience(a, c) {
		t.Fatal("byte-equal nested objects must match")
	}
}
