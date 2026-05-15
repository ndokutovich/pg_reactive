package secrets

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
)

func newTestBox(t *testing.T) *Box {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b, err := New(key)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b
}

func TestEncryptDecrypt_Roundtrip(t *testing.T) {
	b := newTestBox(t)
	pt := []byte(`{"DATABASE_URL":"postgres://...","STRIPE_KEY":"sk_test_..."}`)
	ct, err := b.Encrypt(pt)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if bytes.Equal(ct, pt) {
		t.Fatal("ciphertext equals plaintext")
	}
	got, err := b.Decrypt(ct)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(got, pt) {
		t.Fatalf("roundtrip mismatch: got %q want %q", got, pt)
	}
}

func TestEncrypt_DifferentNoncePerCall(t *testing.T) {
	b := newTestBox(t)
	pt := []byte("same plaintext")
	c1, _ := b.Encrypt(pt)
	c2, _ := b.Encrypt(pt)
	if bytes.Equal(c1, c2) {
		t.Fatal("two encryptions of the same plaintext produced identical ciphertext (nonce reuse)")
	}
}

func TestDecrypt_TamperDetected(t *testing.T) {
	b := newTestBox(t)
	ct, _ := b.Encrypt([]byte("secret"))
	// flip a byte in the tag/ciphertext area
	ct[len(ct)-1] ^= 0xFF
	_, err := b.Decrypt(ct)
	if !errors.Is(err, ErrBadCiphertext) {
		t.Fatalf("tampered ciphertext must error: got %v", err)
	}
}

func TestDecrypt_UnknownVersion(t *testing.T) {
	b := newTestBox(t)
	ct, _ := b.Encrypt([]byte("x"))
	ct[0] = 0xFE
	_, err := b.Decrypt(ct)
	if !errors.Is(err, ErrBadCiphertext) {
		t.Fatalf("bad version must error: got %v", err)
	}
}

func TestEmptyRoundtrip(t *testing.T) {
	b := newTestBox(t)
	ct, err := b.Encrypt(nil)
	if err != nil || ct != nil {
		t.Fatalf("nil plaintext must encrypt to nil, got ct=%v err=%v", ct, err)
	}
	pt, err := b.Decrypt(nil)
	if err != nil || pt != nil {
		t.Fatalf("nil ciphertext must decrypt to nil, got pt=%v err=%v", pt, err)
	}
}

func TestNilBox_ErrorsOnNonEmpty(t *testing.T) {
	var b *Box
	if _, err := b.Encrypt([]byte("x")); !errors.Is(err, ErrNoKey) {
		t.Fatalf("nil box must error on encrypt, got %v", err)
	}
	if _, err := b.Decrypt([]byte{0x01, 0, 0}); !errors.Is(err, ErrNoKey) {
		t.Fatalf("nil box must error on decrypt, got %v", err)
	}
}

func TestNilBox_PassThroughEmpty(t *testing.T) {
	// Empty in, empty out — works without a key so callers can boot without
	// configuring SECRETS_ENCRYPTION_KEY when nothing needs encryption.
	var b *Box
	if got, err := b.Encrypt(nil); err != nil || got != nil {
		t.Fatalf("nil box must pass through empty, got %v %v", got, err)
	}
	if got, err := b.Decrypt(nil); err != nil || got != nil {
		t.Fatalf("nil box must pass through empty, got %v %v", got, err)
	}
}

func TestDecodeKey_AcceptsBothBase64Variants(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	std := base64.StdEncoding.EncodeToString(raw)
	url := base64.URLEncoding.EncodeToString(raw)

	if got, err := DecodeKey(std); err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("std base64 round-trip failed: %v %v", got, err)
	}
	if got, err := DecodeKey(url); err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("url base64 round-trip failed: %v %v", got, err)
	}
	if got, err := DecodeKey(""); err != nil || got != nil {
		t.Fatalf("empty must return (nil, nil), got %v %v", got, err)
	}
}

func TestDecodeKey_RejectsWrongLength(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(make([]byte, 16))
	if _, err := DecodeKey(short); err == nil {
		t.Fatal("16-byte key must be rejected")
	}
	long := base64.StdEncoding.EncodeToString(make([]byte, 48))
	if _, err := DecodeKey(long); err == nil {
		t.Fatal("48-byte key must be rejected")
	}
}
