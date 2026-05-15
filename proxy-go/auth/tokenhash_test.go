package auth

import "testing"

func TestHashToken_Deterministic(t *testing.T) {
	a := HashToken("abc123")
	b := HashToken("abc123")
	if a != b {
		t.Fatalf("hash not deterministic: %s != %s", a, b)
	}
}

func TestHashToken_DifferentInputs(t *testing.T) {
	if HashToken("a") == HashToken("b") {
		t.Fatal("distinct inputs produced the same hash")
	}
}

func TestHashToken_FixedLengthHex(t *testing.T) {
	h := HashToken("anything")
	if len(h) != 64 {
		t.Fatalf("sha256 hex must be 64 chars, got %d", len(h))
	}
	for _, r := range h {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Fatalf("non-hex char in hash: %q", r)
		}
	}
}

func TestHashToken_EmptyInput(t *testing.T) {
	// Empty input is technically valid (well-known hash); just ensure no panic.
	const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := HashToken(""); got != emptySHA256 {
		t.Fatalf("sha256('') unexpected: %s", got)
	}
}
