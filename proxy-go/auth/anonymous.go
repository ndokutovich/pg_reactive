package auth

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// Anonymous mints a short-lived role=anon JWT with a random sub. Lets
// public-read demo pages satisfy REQUIRE_AUTHENTICATED_WS=true without
// embedding the raw anon-key as a fake credential — the WS gate receives
// a real signed token, expirable and attributable.
//
// Default-deny: returns 503 unless AllowAnonymousSignin is explicitly set.
// No DB row is created — the identity is purely ephemeral. There is no
// refresh token; clients re-mint when the access token expires.
//
// Rate-limit responsibility belongs to the surrounding router group
// (state.RateLimiter.Middleware), so this handler does not gate itself
// — keeping it consistent with Signup / Token / Magiclink siblings.
func Anonymous(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.AllowAnonymousSignin {
			writeError(w, http.StatusServiceUnavailable,
				"anonymous signin is disabled")
			return
		}

		ttl := d.AnonymousJWTTTLSecs
		if ttl <= 0 {
			ttl = 3600
		}

		sub := uuid.New().String()
		access, err := GenerateToken(sub, "anon", "", d.JWTSecret, ttl)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		now := time.Now().UTC()
		writeJSON(w, http.StatusOK, AuthResponse{
			AccessToken: access,
			TokenType:   "bearer",
			ExpiresIn:   ttl,
			User: UserResponse{
				ID:           sub,
				Role:         "anon",
				UserMetadata: json.RawMessage("{}"),
				AppMetadata:  json.RawMessage("{}"),
				CreatedAt:    now,
				UpdatedAt:    now,
				Provider:     "anonymous",
				IsAnonymous:  true,
			},
		})
	}
}
