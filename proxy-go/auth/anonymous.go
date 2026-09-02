package auth

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// anonymousEmailDomain is reserved by RFC 2606: `.invalid` can never be
// registered, routed, or claimed. A guest account still has to satisfy
// pgstack.users.email UNIQUE NOT NULL, and an address here cannot collide with
// a real one an identity provider might later return for the same person.
const anonymousEmailDomain = "@anonymous.invalid"

// Anonymous creates a REAL account for a guest and signs them in.
//
// It used to mint a bare role=anon JWT with a random sub and no database row,
// on the theory that a guest is ephemeral. That made the identity a fiction:
// anything that verifies the caller against pgstack.users refused it, and the
// account evaporated on reload, so a guest could never keep progress or later
// attach a permanent identity to it — which is the whole reason to offer
// anonymous signin rather than demanding a provider on first sight.
//
// So: a row with provider 'anonymous' and role 'authenticated' (RLS policies
// are written TO authenticated — a guest that cannot read its own row is not
// an account), plus a refresh token, so the guest survives closing the tab.
// `email_confirmed_at` stays NULL: there is no address, and nothing was
// confirmed. Nothing refuses on that today except the OAuth merge, which
// cannot reach a `.invalid` address anyway.
//
// Default-deny: returns 503 unless AllowAnonymousSignin is explicitly set.
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

		// Before the row, not after. GenerateToken refuses an empty secret, and
		// the insert used to run first — so a request that could never be
		// answered still left a guest account behind. Checking here keeps the
		// database untouched by a request we already know will fail.
		if d.JWTSecret == "" {
			log.Error().Msg("anonymous signin refused: JWT_SECRET is empty")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		ttl := d.AnonymousJWTTTLSecs
		if ttl <= 0 {
			ttl = 3600
		}

		ctx := r.Context()
		// The id is chosen here rather than left to the column default so the
		// synthetic address names the row it belongs to — a guest account is
		// otherwise unidentifiable in the table it lives in.
		id := uuid.New().String()
		email := "anon-" + id + anonymousEmailDomain

		// 0.3.0: guests are a fourth principal. Strict mode (default) creates
		// the row with role=anonymous, so `TO authenticated` policies never
		// match a guest (SECURITY.md INV-A); ANONYMOUS_ROLE=authenticated is
		// the Supabase-compatible flat model. Either way the JWT carries
		// is_anonymous, derived from the row (INV-B).
		guestRole := d.AnonymousRole
		if guestRole != "anonymous" && guestRole != "authenticated" {
			guestRole = "anonymous" // Config.Validate refuses other values; belt-and-braces
		}

		var userID, role string
		var createdAt, updatedAt time.Time
		row := d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (id, email, role, provider, providers)
			VALUES ($1, $2, $3, 'anonymous', ARRAY['anonymous'])
			RETURNING id, role, created_at, updated_at
		`, id, email, guestRole)
		if err := row.Scan(&userID, &role, &createdAt, &updatedAt); err != nil {
			log.Error().Err(err).Msg("create anonymous user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		access, refresh, err := generateTokenPairTTL(ctx, d, userID, email, role, ttl,
			map[string]any{"is_anonymous": true})
		if err != nil {
			log.Error().Err(err).Msg("generate token pair for anonymous signin")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, AuthResponse{
			AccessToken:  access,
			TokenType:    "bearer",
			ExpiresIn:    ttl,
			RefreshToken: refresh,
			User: UserResponse{
				ID:           userID,
				Email:        email,
				Role:         role,
				UserMetadata: json.RawMessage("{}"),
				AppMetadata:  json.RawMessage("{}"),
				CreatedAt:    createdAt,
				UpdatedAt:    updatedAt,
				Provider:     "anonymous",
				IsAnonymous:  true,
			},
		})
	}
}
