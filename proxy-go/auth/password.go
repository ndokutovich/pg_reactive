package auth

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// OWASP-recommended Argon2id parameters (2023 guidance).
const (
	argonMemory  = 19456 // 19 MiB
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashPassword derives an Argon2id hash for the given plain-text password.
// The returned string is in PHC format:
//
//	$argon2id$v=19$m=19456,t=2,p=1$<salt_base64url>$<hash_base64url>
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	saltB64 := base64.RawURLEncoding.EncodeToString(salt)
	hashB64 := base64.RawURLEncoding.EncodeToString(hash)

	encoded := fmt.Sprintf(
		"$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonTime, argonThreads,
		saltB64, hashB64,
	)
	return encoded, nil
}

// VerifyPassword checks whether password matches the stored PHC-format hash.
// Returns (true, nil) on match, (false, nil) on mismatch, and (false, err) only
// when the hash string is malformed or an internal error occurs.
func VerifyPassword(password, hash string) (bool, error) {
	salt, derivedLen, time, memory, threads, stored, err := parseArgon2Hash(hash)
	if err != nil {
		return false, fmt.Errorf("parse hash: %w", err)
	}

	candidate := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(derivedLen))

	// Constant-time byte comparison.
	if len(candidate) != len(stored) {
		return false, nil
	}
	var diff byte
	for i := range candidate {
		diff |= candidate[i] ^ stored[i]
	}
	return diff == 0, nil
}

// parseArgon2Hash parses the PHC-format string produced by HashPassword.
// Format: $argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt>$<hash>
func parseArgon2Hash(encoded string) (salt []byte, keyLen int, t, m uint32, p uint8, hash []byte, err error) {
	// Split by "$": ["", "argon2id", "v=19", "m=...,t=...,p=...", "<salt>", "<hash>"]
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		err = fmt.Errorf("invalid hash format: expected 6 parts, got %d", len(parts))
		return
	}
	if parts[1] != "argon2id" {
		err = fmt.Errorf("unsupported algorithm: %s", parts[1])
		return
	}

	// Parse params from "m=19456,t=2,p=1"
	paramStr := parts[3]
	for _, kv := range strings.Split(paramStr, ",") {
		pair := strings.SplitN(kv, "=", 2)
		if len(pair) != 2 {
			err = fmt.Errorf("invalid param pair: %s", kv)
			return
		}
		val, parseErr := strconv.ParseUint(pair[1], 10, 32)
		if parseErr != nil {
			err = fmt.Errorf("invalid param value %q: %w", pair[1], parseErr)
			return
		}
		switch pair[0] {
		case "m":
			m = uint32(val)
		case "t":
			t = uint32(val)
		case "p":
			p = uint8(val)
		}
	}

	salt, err = base64.RawURLEncoding.DecodeString(parts[4])
	if err != nil {
		err = fmt.Errorf("decode salt: %w", err)
		return
	}

	hash, err = base64.RawURLEncoding.DecodeString(parts[5])
	if err != nil {
		err = fmt.Errorf("decode hash: %w", err)
		return
	}

	keyLen = len(hash)
	return
}
