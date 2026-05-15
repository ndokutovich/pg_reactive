package auth

import (
	"crypto/sha256"
	"encoding/hex"
)

// HashToken returns the lowercase hex sha256 of an opaque token.
//
// Used to store refresh tokens and email tokens (verify / recover / magic
// link) in the database as hashes rather than plaintext, so a DB dump or
// stolen backup does not become a credential dump. Lookups always hash the
// presented token and search by the hashed column.
//
// SHA-256 is appropriate here because (a) the input is high-entropy random
// bytes (not user-chosen, not low-entropy), so we don't need a slow KDF
// like bcrypt — collision/preimage resistance is sufficient; and (b) the
// hash must be deterministic for index lookup.
func HashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
