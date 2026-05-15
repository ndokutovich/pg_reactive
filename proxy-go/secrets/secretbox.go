// Package secrets provides authenticated symmetric encryption for at-rest
// credentials persisted in the database (currently: edge function env vars;
// audit finding F6).
//
// Algorithm: AES-256-GCM. The key is loaded from the SECRETS_ENCRYPTION_KEY
// env var as 32 raw bytes, base64-encoded. Nonces are random 12 bytes and
// stored alongside the ciphertext.
//
// Wire format (single []byte stored in the DB column):
//
//	[1 byte version=0x01] [12 bytes nonce] [ciphertext+tag]
//
// The version byte lets us evolve the algorithm later without an in-place
// migration. Empty input encrypts to empty output (no-op) so callers can
// treat "no secrets configured" as the natural identity case.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

const (
	// version byte for AES-256-GCM with random nonce.
	versionAESGCM byte = 0x01
	nonceSize          = 12
	keySize            = 32
)

// ErrNoKey is returned when an operation requires the encryption key but none
// has been configured.
var ErrNoKey = errors.New("secrets: SECRETS_ENCRYPTION_KEY not configured")

// ErrBadCiphertext is returned for any malformed input — wrong version byte,
// short payload, GCM authentication failure.
var ErrBadCiphertext = errors.New("secrets: ciphertext is malformed or tampered")

// Box holds the AEAD primitive once the key has been validated. A nil Box is
// safe to use: Encrypt/Decrypt return ErrNoKey on any non-empty input.
type Box struct {
	aead cipher.AEAD
}

// DecodeKey parses the base64-encoded SECRETS_ENCRYPTION_KEY value. Returns
// (nil, nil) for an empty string so callers can run without encryption when
// no secrets are configured.
func DecodeKey(b64 string) ([]byte, error) {
	if b64 == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		// Allow URL-safe base64 too — easier to copy from openssl rand -base64.
		key, err = base64.URLEncoding.DecodeString(b64)
		if err != nil {
			return nil, fmt.Errorf("SECRETS_ENCRYPTION_KEY: %w", err)
		}
	}
	if len(key) != keySize {
		return nil, fmt.Errorf("SECRETS_ENCRYPTION_KEY: expected %d bytes, got %d", keySize, len(key))
	}
	return key, nil
}

// New builds a Box from a raw 32-byte key. Returns nil when key is nil/empty
// so the proxy can boot without encryption and individual call sites can
// treat that as "no secret support".
func New(key []byte) (*Box, error) {
	if len(key) == 0 {
		return nil, nil
	}
	if len(key) != keySize {
		return nil, fmt.Errorf("secrets.New: expected %d bytes, got %d", keySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Encrypt wraps plaintext in [version|nonce|ciphertext+tag]. Empty input is
// returned unchanged (no version byte) so callers can store "no secret" as
// the natural empty []byte.
func (b *Box) Encrypt(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 {
		return nil, nil
	}
	if b == nil {
		return nil, ErrNoKey
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("secrets.Encrypt: read nonce: %w", err)
	}
	out := make([]byte, 0, 1+nonceSize+len(plaintext)+b.aead.Overhead())
	out = append(out, versionAESGCM)
	out = append(out, nonce...)
	out = b.aead.Seal(out, nonce, plaintext, nil)
	return out, nil
}

// Decrypt reverses Encrypt. Returns nil for empty input (paired with the
// no-op encrypt of empty plaintext).
func (b *Box) Decrypt(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	if b == nil {
		return nil, ErrNoKey
	}
	if len(blob) < 1+nonceSize+b.aead.Overhead() {
		return nil, ErrBadCiphertext
	}
	if blob[0] != versionAESGCM {
		return nil, fmt.Errorf("secrets.Decrypt: unknown version 0x%02x: %w", blob[0], ErrBadCiphertext)
	}
	nonce := blob[1 : 1+nonceSize]
	ct := blob[1+nonceSize:]
	pt, err := b.aead.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("secrets.Decrypt: %w", ErrBadCiphertext)
	}
	return pt, nil
}
