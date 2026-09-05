package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────────────────────

// generateOpaqueToken returns 32 random bytes encoded as base64url (no padding).
// Used for refresh tokens stored in the DB.
func generateOpaqueToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// generateHexToken returns 32 random bytes hex-encoded.
// Used for email tokens (verification, recovery, magic-link).
func generateHexToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// consumeEmailToken atomically marks a pgstack.email_tokens row as used and
// returns its user_id. The single UPDATE filters on used_at IS NULL AND
// expires_at > now() so two parallel verifications of the same token can't
// both succeed. Returns pgx.ErrNoRows when the token is unknown, already
// used, or expired — callers should respond with a generic 400 in that case
// (do not leak which condition matched). Audit F6.
func consumeEmailToken(ctx context.Context, q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, tokenHash, tokenType string) (userID string, tokenEmail *string, err error) {
	err = q.QueryRow(ctx, `
		UPDATE pgstack.email_tokens
		SET used_at = now()
		WHERE token_hash = $1
		  AND token_type = $2
		  AND used_at IS NULL
		  AND expires_at > now()
		RETURNING user_id, email
	`, tokenHash, tokenType).Scan(&userID, &tokenEmail)
	return userID, tokenEmail, err
}

// generateTokenPair mints a JWT access token and an opaque refresh token,
// persists the refresh token in pgstack.refresh_tokens, and returns both.
func generateTokenPair(ctx context.Context, d *Deps, userID, email, role string) (access, refresh string, err error) {
	return generateTokenPairTTL(ctx, d, userID, email, role, d.AccessTokenExpirySecs, nil)
}

// generateTokenPairTTL is generateTokenPair with the access-token lifetime and
// extra claims named explicitly. Anonymous signin has its own TTL
// (AnonymousJWTTTLSecs) and carries is_anonymous; it would otherwise have to
// choose between honouring those and having a refresh token at all.
func generateTokenPairTTL(ctx context.Context, d *Deps, userID, email, role string, accessTTLSecs int, extra map[string]any) (access, refresh string, err error) {
	access, err = GenerateTokenExtra(userID, role, email, d.JWTSecret, accessTTLSecs, extra)
	if err != nil {
		return "", "", fmt.Errorf("generate access token: %w", err)
	}

	refresh = generateOpaqueToken()
	familyID := uuid.New().String()
	expiresAt := time.Now().UTC().Add(time.Duration(d.RefreshTokenExpiryDays) * 24 * time.Hour)

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO pgstack.refresh_tokens (user_id, token_hash, family_id, expires_at)
		VALUES ($1, $2, $3, $4)
	`, userID, HashToken(refresh), familyID, expiresAt)
	if err != nil {
		return "", "", fmt.Errorf("persist refresh token: %w", err)
	}

	return access, refresh, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Signup — POST /auth/v1/signup
// ─────────────────────────────────────────────────────────────────────────────

// Signup registers a new user with email + password.
func Signup(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email    string          `json:"email"`
			Password string          `json:"password"`
			Data     json.RawMessage `json:"data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		body.Email = strings.TrimSpace(strings.ToLower(body.Email))
		if _, err := mail.ParseAddress(body.Email); err != nil {
			writeError(w, http.StatusBadRequest, "invalid email address")
			return
		}
		if len(body.Password) < 8 {
			writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		if len(body.Password) > 256 {
			writeError(w, http.StatusBadRequest, "password must be at most 256 characters")
			return
		}

		hashed, err := HashPassword(body.Password)
		if err != nil {
			log.Error().Err(err).Msg("hash password")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		userMeta := json.RawMessage("{}")
		if len(body.Data) > 0 && string(body.Data) != "null" {
			userMeta = body.Data
		}

		ctx := r.Context()

		var userID, role string
		var createdAt, updatedAt time.Time
		var emailConfirmedAt *time.Time

		// A new user is confirmed immediately ONLY when verification is off; when
		// REQUIRE_EMAIL_VERIFICATION is on it stays NULL so the login gate (and
		// the email_confirmed_at IS NULL check) actually fires (gemini audit P1).
		var signupConfirmedAt *time.Time
		if !d.RequireEmailVerification {
			now := time.Now().UTC()
			signupConfirmedAt = &now
		}

		err = d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, encrypted_password, raw_user_meta, email_confirmed_at)
			VALUES ($1, $2, $3, $4)
			RETURNING id, role, created_at, updated_at, email_confirmed_at
		`, body.Email, hashed, userMeta, signupConfirmedAt).Scan(&userID, &role, &createdAt, &updatedAt, &emailConfirmedAt)
		if err != nil {
			if isUniqueViolation(err) {
				writeError(w, http.StatusConflict, "email already registered")
				return
			}
			log.Error().Err(err).Msg("insert user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if d.RequireEmailVerification {
			tok := generateHexToken()
			exp := time.Now().UTC().Add(24 * time.Hour)
			_, err = d.Pool.Exec(ctx, `
				INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, email, expires_at)
				VALUES ($1, $2, 'email_verification', $3, $4)
			`, userID, HashToken(tok), body.Email, exp)
			if err != nil {
				log.Error().Err(err).Msg("create email verification token")
			}

			if d.Mailer != nil {
				verifyURL := fmt.Sprintf("%s/auth/v1/verify?token=%s", d.SiteURL, tok)
				if err := d.Mailer.SendEmailVerification(r.Context(), body.Email, verifyURL); err != nil {
					log.Error().Err(err).Msg("send verification email")
				}
			}

			writeJSON(w, http.StatusOK, map[string]string{
				"message": "Check your email to confirm your account",
			})
			return
		}

		access, refresh, err := generateTokenPair(ctx, d, userID, body.Email, role)
		if err != nil {
			log.Error().Err(err).Msg("generate token pair")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusCreated, AuthResponse{
			AccessToken:  access,
			TokenType:    "bearer",
			ExpiresIn:    d.AccessTokenExpirySecs,
			RefreshToken: refresh,
			User: UserResponse{
				ID:               userID,
				Email:            body.Email,
				Role:             role,
				UserMetadata:     userMeta,
				AppMetadata:      json.RawMessage("{}"),
				CreatedAt:        createdAt,
				UpdatedAt:        updatedAt,
				EmailConfirmedAt: emailConfirmedAt,
				Provider:         "email",
			},
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Token — POST /auth/v1/token
// ─────────────────────────────────────────────────────────────────────────────

// Token handles password and refresh_token grant types.
func Token(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			GrantType    string `json:"grant_type"`
			Email        string `json:"email"`
			Password     string `json:"password"`
			RefreshToken string `json:"refresh_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		ctx := r.Context()

		switch body.GrantType {
		case "password":
			handlePasswordGrant(w, r, ctx, d, body.Email, body.Password)
		case "refresh_token":
			handleRefreshGrant(w, r, ctx, d, body.RefreshToken)
		default:
			writeError(w, http.StatusBadRequest, "unsupported grant_type")
		}
	}
}

func handlePasswordGrant(w http.ResponseWriter, r *http.Request, ctx context.Context, d *Deps, email, password string) {
	email = strings.TrimSpace(strings.ToLower(email))

	row := d.Pool.QueryRow(ctx, `
		SELECT id, encrypted_password, role,
		       COALESCE(raw_user_meta, '{}')::jsonb,
		       COALESCE(raw_app_meta, '{}')::jsonb,
		       created_at, updated_at, email_confirmed_at, provider,
		       COALESCE(providers, '{}'::text[])
		FROM pgstack.users
		WHERE email = $1
	`, email)

	var (
		userID           string
		encryptedPwd     string
		role             string
		userMeta         []byte
		appMeta          []byte
		createdAt        time.Time
		updatedAt        time.Time
		emailConfirmedAt *time.Time
		provider         string
		providers        []string
	)
	err := row.Scan(&userID, &encryptedPwd, &role, &userMeta, &appMeta, &createdAt, &updatedAt, &emailConfirmedAt, &provider, &providers)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}
		log.Error().Err(err).Msg("fetch user for password grant")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	ok, err := VerifyPassword(password, encryptedPwd)
	if err != nil {
		log.Error().Err(err).Msg("verify password")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	// Reject login if email verification is required but not confirmed.
	if d.RequireEmailVerification && emailConfirmedAt == nil {
		writeError(w, http.StatusForbidden, "email not verified")
		return
	}

	// INV-B (round 47 H2): the guest marker and the guest TTL derive from the
	// ROW at this mint site too — exactly like refresh rotation. A guest that
	// set ONLY a password (providers still {anonymous}) must not launder
	// itself into an unmarked member token via password login; in compat mode
	// (row role = authenticated) the minted JWT was otherwise
	// indistinguishable from a member's.
	isGuest := len(providers) == 1 && providers[0] == "anonymous"
	ttl := d.AccessTokenExpirySecs
	var extra map[string]any
	if isGuest {
		extra = map[string]any{"is_anonymous": true}
		ttl = d.AnonymousJWTTTLSecs
		if ttl <= 0 {
			ttl = 3600
		}
	}
	access, refresh, err := generateTokenPairTTL(ctx, d, userID, email, role, ttl, extra)
	if err != nil {
		log.Error().Err(err).Msg("generate token pair (password grant)")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  access,
		TokenType:    "bearer",
		ExpiresIn:    ttl,
		RefreshToken: refresh,
		User: UserResponse{
			ID:               userID,
			Email:            email,
			Role:             role,
			UserMetadata:     json.RawMessage(userMeta),
			AppMetadata:      json.RawMessage(appMeta),
			CreatedAt:        createdAt,
			UpdatedAt:        updatedAt,
			EmailConfirmedAt: emailConfirmedAt,
			Provider:         provider,
			IsAnonymous:      isGuest,
		},
	})
}

func handleRefreshGrant(w http.ResponseWriter, r *http.Request, ctx context.Context, d *Deps, refreshToken string) {
	if refreshToken == "" {
		writeError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	tokenHash := HashToken(refreshToken)

	// Audit F6: atomic consume. Two parallel refreshes with the same token
	// must not both succeed. The UPDATE filters on revoked=false so only one
	// statement can flip it, and RETURNING gives us the row's identity in
	// the same round-trip — no SELECT→UPDATE race.
	newRefresh := generateOpaqueToken()
	newExpiry := time.Now().UTC().Add(time.Duration(d.RefreshTokenExpiryDays) * 24 * time.Hour)

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		log.Error().Err(err).Msg("begin refresh rotation tx")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		userID    string
		familyID  string
	)
	err = tx.QueryRow(ctx, `
		UPDATE pgstack.refresh_tokens
		SET revoked = true
		WHERE token_hash = $1 AND revoked = false AND expires_at > now()
		RETURNING user_id, family_id
	`, tokenHash).Scan(&userID, &familyID)
	if err != nil {
		if err != pgx.ErrNoRows {
			log.Error().Err(err).Msg("atomic refresh consume")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		// 0 rows: either unknown, already-revoked (replay), or expired.
		// Resolve which separately. Pool is fine here — we are not part of
		// the rotation tx anymore on this path.
		var prevRevoked bool
		var prevExpires time.Time
		var prevFamily string
		lookupErr := d.Pool.QueryRow(ctx, `
			SELECT revoked, expires_at, family_id
			FROM pgstack.refresh_tokens
			WHERE token_hash = $1
		`, tokenHash).Scan(&prevRevoked, &prevExpires, &prevFamily)
		if lookupErr == pgx.ErrNoRows {
			writeError(w, http.StatusUnauthorized, "invalid refresh token")
			return
		}
		if lookupErr != nil {
			log.Error().Err(lookupErr).Msg("resolve failed refresh consume")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if prevRevoked {
			// Replay of a previously-rotated token — burn the whole family.
			_, _ = d.Pool.Exec(ctx, `
				DELETE FROM pgstack.refresh_tokens WHERE family_id = $1
			`, prevFamily)
			writeError(w, http.StatusUnauthorized, "refresh token reuse detected — please log in again")
			return
		}
		// Otherwise the token is plain expired.
		writeError(w, http.StatusUnauthorized, "refresh token expired")
		return
	}

	// Old token revoked atomically above. Issue the rotated one in the same tx.
	_, err = tx.Exec(ctx, `
		INSERT INTO pgstack.refresh_tokens (user_id, token_hash, family_id, expires_at)
		VALUES ($1, $2, $3, $4)
	`, userID, HashToken(newRefresh), familyID, newExpiry)
	if err != nil {
		log.Error().Err(err).Msg("insert rotated refresh token")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error().Err(err).Msg("commit refresh rotation")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Fetch user for the response.
	user, err := fetchUserByID(ctx, d.Pool, userID)
	if err != nil {
		log.Error().Err(err).Msg("fetch user for refresh grant")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// INV-B: is_anonymous is derived from the row at every mint site. A guest
	// keeps the claim (and the guest TTL, D7) across rotation; an upgraded
	// account loses both on its next refresh because the row flipped.
	ttl := d.AccessTokenExpirySecs
	var extra map[string]any
	if user.IsAnonymous {
		extra = map[string]any{"is_anonymous": true}
		ttl = d.AnonymousJWTTTLSecs
		if ttl <= 0 {
			ttl = 3600
		}
	}
	access, err := GenerateTokenExtra(userID, user.Role, user.Email, d.JWTSecret, ttl, extra)
	if err != nil {
		log.Error().Err(err).Msg("generate access token for refresh grant")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  access,
		TokenType:    "bearer",
		ExpiresIn:    ttl,
		RefreshToken: newRefresh,
		User:         *user,
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// GetUser — GET /auth/v1/user  (JWT required)
// ─────────────────────────────────────────────────────────────────────────────

func GetUser(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := requireJWT(w, r, d.JWTSecret)
		if claims == nil {
			return
		}

		user, err := fetchUserByID(r.Context(), d.Pool, claims.Sub)
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusNotFound, "user not found")
				return
			}
			log.Error().Err(err).Msg("get user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, user)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// UpdateUser — PATCH /auth/v1/user  (JWT required)
// ─────────────────────────────────────────────────────────────────────────────

func UpdateUser(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := requireJWT(w, r, d.JWTSecret)
		if claims == nil {
			return
		}

		var body struct {
			Email    *string         `json:"email"`
			Password *string         `json:"password"`
			Data     json.RawMessage `json:"data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		ctx := r.Context()

		// Every mutation runs in ONE transaction so a partial failure can never
		// leave the account inconsistent — a new password active while old
		// refresh tokens still mint access tokens (finding 4), or an email
		// changed without its verification re-armed / old tokens revoked
		// (finding 2). gemini audit.
		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin user update tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		// Captured to send the verification mail AFTER commit — never for a
		// change that then rolls back.
		var pendingVerifyEmail, pendingVerifyToken string

		if body.Email != nil {
			newEmail := strings.TrimSpace(strings.ToLower(*body.Email))
			if _, perr := mail.ParseAddress(newEmail); perr != nil {
				writeError(w, http.StatusBadRequest, "invalid email address")
				return
			}
			// The new address is unverified. When verification is required, CLEAR
			// email_confirmed_at so the login gate refuses the new address until
			// it is re-verified — otherwise the change silently inherits the old
			// address's confirmed status (gemini audit P1).
			if d.RequireEmailVerification {
				_, err = tx.Exec(ctx, `
					UPDATE pgstack.users SET email = $1, email_confirmed_at = NULL, updated_at = now() WHERE id = $2
				`, newEmail, claims.Sub)
			} else {
				// No verification required → the address change IS the upgrade
				// for a guest row (0.3.0): flip role/provider here, since no
				// confirm step will run. Non-guest rows: CASEs are no-ops.
				_, err = tx.Exec(ctx, `
					UPDATE pgstack.users
					SET email      = $1,
					    role       = CASE WHEN role = 'anonymous' THEN 'authenticated' ELSE role END,
					    provider   = CASE WHEN providers = ARRAY['anonymous'] THEN 'email' ELSE provider END,
					    providers  = CASE WHEN providers = ARRAY['anonymous'] THEN ARRAY['anonymous','email'] ELSE providers END,
					    updated_at = now()
					WHERE id = $2
				`, newEmail, claims.Sub)
			}
			if err != nil {
				if isUniqueViolation(err) {
					writeError(w, http.StatusConflict, "email already in use")
					return
				}
				log.Error().Err(err).Msg("update user email")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			if d.RequireEmailVerification {
				// Revoke every outstanding verification token: one minted for the
				// OLD address must not survive to confirm the new one (finding 2).
				if _, err = tx.Exec(ctx, `
					DELETE FROM pgstack.email_tokens
					WHERE user_id = $1 AND token_type = 'email_verification' AND used_at IS NULL
				`, claims.Sub); err != nil {
					log.Error().Err(err).Msg("revoke stale verification tokens on email change")
					writeError(w, http.StatusInternalServerError, "internal error")
					return
				}
				// Issue a fresh token BOUND to the new address.
				tok := generateHexToken()
				exp := time.Now().UTC().Add(24 * time.Hour)
				if _, err = tx.Exec(ctx, `
					INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, email, expires_at)
					VALUES ($1, $2, 'email_verification', $3, $4)
				`, claims.Sub, HashToken(tok), newEmail, exp); err != nil {
					log.Error().Err(err).Msg("create verification token on email change")
					writeError(w, http.StatusInternalServerError, "internal error")
					return
				}
				pendingVerifyEmail, pendingVerifyToken = newEmail, tok
			}
		}

		if body.Password != nil {
			if len(*body.Password) < 8 {
				writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
				return
			}
			if len(*body.Password) > 256 {
				writeError(w, http.StatusBadRequest, "password must be at most 256 characters")
				return
			}
			hashed, herr := HashPassword(*body.Password)
			if herr != nil {
				log.Error().Err(herr).Msg("hash new password")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			if _, err = tx.Exec(ctx, `
				UPDATE pgstack.users SET encrypted_password = $1, updated_at = now() WHERE id = $2
			`, hashed, claims.Sub); err != nil {
				log.Error().Err(err).Msg("update user password")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			// Revoke every session in the SAME transaction as the password update
			// so a fault cannot leave the new password active while old refresh
			// tokens still mint access tokens (gemini audit finding 4).
			if _, err = tx.Exec(ctx, `
				DELETE FROM pgstack.refresh_tokens WHERE user_id = $1
			`, claims.Sub); err != nil {
				log.Error().Err(err).Msg("revoke sessions after password change")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}

		if len(body.Data) > 0 && string(body.Data) != "null" {
			if _, err = tx.Exec(ctx, `
				UPDATE pgstack.users SET raw_user_meta = $1, updated_at = now() WHERE id = $2
			`, body.Data, claims.Sub); err != nil {
				log.Error().Err(err).Msg("update user metadata")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}

		if err = tx.Commit(ctx); err != nil {
			log.Error().Err(err).Msg("commit user update")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// After-commit: send the verification mail for a changed address (kept
		// out of the tx so a send never races a rolled-back change).
		if pendingVerifyToken != "" && d.Mailer != nil {
			verifyURL := fmt.Sprintf("%s/auth/v1/verify?token=%s", d.SiteURL, pendingVerifyToken)
			if merr := d.Mailer.SendEmailVerification(r.Context(), pendingVerifyEmail, verifyURL); merr != nil {
				log.Error().Err(merr).Msg("send verification email on email change")
			}
		}

		user, err := fetchUserByID(ctx, d.Pool, claims.Sub)
		if err != nil {
			log.Error().Err(err).Msg("fetch updated user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, user)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Logout — POST /auth/v1/logout  (JWT required)
// ─────────────────────────────────────────────────────────────────────────────

func Logout(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := requireJWT(w, r, d.JWTSecret)
		if claims == nil {
			return
		}

		_, err := d.Pool.Exec(r.Context(), `
			DELETE FROM pgstack.refresh_tokens WHERE user_id = $1
		`, claims.Sub)
		if err != nil {
			log.Error().Err(err).Msg("delete refresh tokens on logout")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Recover — POST /auth/v1/recover  (public)
// ─────────────────────────────────────────────────────────────────────────────

func Recover(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.EmailEnabled {
			writeError(w, http.StatusServiceUnavailable, "email-based flows are disabled on this deployment (EMAIL_ENABLED=false)")
			return
		}
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		body.Email = strings.TrimSpace(strings.ToLower(body.Email))

		ctx := r.Context()

		// Don't reveal whether the email exists.
		const safeMsg = "If this email exists, a reset link has been sent"

		var userID string
		err := d.Pool.QueryRow(ctx, `
			SELECT id FROM pgstack.users WHERE email = $1
		`, body.Email).Scan(&userID)
		if err != nil {
			// User not found or other error — respond identically.
			writeJSON(w, http.StatusOK, map[string]string{"message": safeMsg})
			return
		}

		tok := generateHexToken()
		exp := time.Now().UTC().Add(1 * time.Hour)
		_, err = d.Pool.Exec(ctx, `
			INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, expires_at)
			VALUES ($1, $2, 'recovery', $3)
		`, userID, HashToken(tok), exp)
		if err != nil {
			log.Error().Err(err).Msg("create recovery token")
			writeJSON(w, http.StatusOK, map[string]string{"message": safeMsg})
			return
		}

		if d.Mailer != nil {
			resetURL := fmt.Sprintf("%s/auth/v1/recover/confirm?token=%s", d.SiteURL, tok)
			if err := d.Mailer.SendPasswordReset(r.Context(), body.Email, resetURL); err != nil {
				log.Error().Err(err).Str("to", body.Email).Msg("send recovery email")
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"message": safeMsg})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// RecoverConfirm — POST /auth/v1/recover/confirm  (public)
// ─────────────────────────────────────────────────────────────────────────────

func RecoverConfirm(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token    string `json:"token"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if body.Token == "" {
			writeError(w, http.StatusBadRequest, "token is required")
			return
		}
		if len(body.Password) < 8 {
			writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		if len(body.Password) > 256 {
			writeError(w, http.StatusBadRequest, "password must be at most 256 characters")
			return
		}

		ctx := r.Context()

		hashed, err := HashPassword(body.Password)
		if err != nil {
			log.Error().Err(err).Msg("hash recovery password")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin recover confirm tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		// Atomic consume (F6) — UPDATE returning user_id is the only path
		// that observes / marks the token; two parallel confirmations of
		// the same token can never both pass the WHERE clause.
		userID, _, err := consumeEmailToken(ctx, tx, HashToken(body.Token), "recovery")
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("consume recovery token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.users SET encrypted_password = $1, updated_at = now() WHERE id = $2
		`, hashed, userID)
		if err != nil {
			log.Error().Err(err).Msg("update password after recovery")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// Revoke every existing session: a password reset is the response to a
		// compromise, so any refresh token issued before it must stop working
		// (gemini audit P1 — otherwise a stolen 30-day refresh survives the reset
		// and mints fresh access tokens). Done in the same tx as the password
		// change so they commit atomically.
		if _, err = tx.Exec(ctx, `
			DELETE FROM pgstack.refresh_tokens WHERE user_id = $1
		`, userID); err != nil {
			log.Error().Err(err).Msg("revoke sessions after recovery")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			log.Error().Err(err).Msg("commit recover confirm")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"message": "Password updated"})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Magiclink — POST /auth/v1/magiclink  (public)
// ─────────────────────────────────────────────────────────────────────────────

func Magiclink(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.EmailEnabled {
			writeError(w, http.StatusServiceUnavailable, "email-based flows are disabled on this deployment (EMAIL_ENABLED=false)")
			return
		}
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		body.Email = strings.TrimSpace(strings.ToLower(body.Email))
		if _, err := mail.ParseAddress(body.Email); err != nil {
			writeError(w, http.StatusBadRequest, "invalid email address")
			return
		}

		ctx := r.Context()

		// Upsert: create account if not exists.
		var userID string
		err := d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, provider, providers)
			VALUES ($1, 'magiclink', ARRAY['magiclink'])
			ON CONFLICT (email) DO UPDATE SET updated_at = now()
			RETURNING id
		`, body.Email).Scan(&userID)
		if err != nil {
			log.Error().Err(err).Msg("upsert magiclink user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		tok := generateHexToken()
		exp := time.Now().UTC().Add(1 * time.Hour)
		_, err = d.Pool.Exec(ctx, `
			INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, expires_at)
			VALUES ($1, $2, 'magiclink', $3)
		`, userID, HashToken(tok), exp)
		if err != nil {
			log.Error().Err(err).Msg("create magiclink token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if d.Mailer != nil {
			verifyURL := fmt.Sprintf("%s/auth/v1/magiclink/verify?token=%s", d.SiteURL, tok)
			if err := d.Mailer.SendMagicLink(r.Context(), body.Email, verifyURL); err != nil {
				log.Error().Err(err).Str("to", body.Email).Msg("send magic link email")
			}
		}

		writeJSON(w, http.StatusOK, map[string]string{"message": "Magic link sent"})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// MagiclinkVerify — GET /auth/v1/magiclink/verify  (public)
// ─────────────────────────────────────────────────────────────────────────────

func MagiclinkVerify(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("token")
		if tok == "" {
			writeError(w, http.StatusBadRequest, "token is required")
			return
		}

		ctx := r.Context()

		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin magiclink verify tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		// Atomic consume (F6).
		userID, _, err := consumeEmailToken(ctx, tx, HashToken(tok), "magiclink")
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("consume magiclink token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.users
			-- Guest upgrade (0.3.0) — same flip as VerifyEmail; see there.
			SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
			    role       = CASE WHEN role = 'anonymous' THEN 'authenticated' ELSE role END,
			    provider   = CASE WHEN providers = ARRAY['anonymous'] THEN 'email' ELSE provider END,
			    providers  = CASE WHEN providers = ARRAY['anonymous'] THEN ARRAY['anonymous','email'] ELSE providers END,
			    updated_at = now()
			WHERE id = $1
		`, userID)
		if err != nil {
			log.Error().Err(err).Msg("confirm email on magiclink verify")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			log.Error().Err(err).Msg("commit magiclink verify")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		user, err := fetchUserByID(ctx, d.Pool, userID)
		if err != nil {
			log.Error().Err(err).Msg("fetch user after magiclink verify")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		access, refresh, err := generateTokenPair(ctx, d, userID, user.Email, user.Role)
		if err != nil {
			log.Error().Err(err).Msg("generate token pair for magiclink")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		redirectURL := fmt.Sprintf("%s#access_token=%s&refresh_token=%s&token_type=bearer&expires_in=%d",
			d.SiteURL, access, refresh, d.AccessTokenExpirySecs)
		http.Redirect(w, r, redirectURL, http.StatusFound)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// VerifyEmail — GET /auth/v1/verify  (public)
// ─────────────────────────────────────────────────────────────────────────────

func VerifyEmail(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("token")
		if tok == "" {
			writeError(w, http.StatusBadRequest, "token is required")
			return
		}

		ctx := r.Context()

		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin email verify tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		// Atomic consume (F6).
		userID, tokenEmail, err := consumeEmailToken(ctx, tx, HashToken(tok), "email_verification")
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("consume email verification token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// Confirm ONLY the address the token was issued for, and only if it is
		// still the user's current email (gemini audit finding 2). A token minted
		// for address X must never confirm a later address Y. tokenEmail is NULL
		// for tokens issued before email-binding existed — those no longer match
		// and are rejected (re-request verification). The token is already
		// consumed above, so a rejected attempt cannot be replayed.
		if tokenEmail == nil {
			writeError(w, http.StatusBadRequest, "verification link is no longer valid")
			return
		}
		ct, err := tx.Exec(ctx, `
			UPDATE pgstack.users
			-- Guest upgrade (0.3.0): confirming a real address on a
			-- never-upgraded guest row completes the account — the row flips
			-- to authenticated/email and is_anonymous derives to false on the
			-- next mint (INV-B). Non-guest rows are untouched by the CASEs.
			SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
			    role       = CASE WHEN role = 'anonymous' THEN 'authenticated' ELSE role END,
			    provider   = CASE WHEN providers = ARRAY['anonymous'] THEN 'email' ELSE provider END,
			    providers  = CASE WHEN providers = ARRAY['anonymous'] THEN ARRAY['anonymous','email'] ELSE providers END,
			    updated_at = now()
			WHERE id = $1 AND email = $2
		`, userID, *tokenEmail)
		if err != nil {
			log.Error().Err(err).Msg("confirm email")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if ct.RowsAffected() == 0 {
			// The token's email is no longer the user's current address — the
			// email was changed after this token was issued. Refuse.
			writeError(w, http.StatusBadRequest, "verification link is no longer valid")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			log.Error().Err(err).Msg("commit email verify")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"message": "Email verified"})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: ListUsers — GET /auth/v1/admin/users  (service_role)
// ─────────────────────────────────────────────────────────────────────────────

func AdminListUsers(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireServiceRole(w, r, d.ServiceRoleKey) {
			return
		}

		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
		if page < 0 {
			page = 0
		}
		if pageSize <= 0 {
			pageSize = 50
		}
		if pageSize > 1000 {
			pageSize = 1000
		}

		rows, err := d.Pool.Query(r.Context(), `
			SELECT id, email, role,
			       COALESCE(raw_user_meta, '{}')::jsonb,
			       COALESCE(raw_app_meta, '{}')::jsonb,
			       created_at, updated_at, email_confirmed_at, provider
			FROM pgstack.users
			ORDER BY created_at DESC
			LIMIT $1 OFFSET $2
		`, pageSize, page*pageSize)
		if err != nil {
			log.Error().Err(err).Msg("admin list users")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer rows.Close()

		users := make([]UserResponse, 0, pageSize)
		for rows.Next() {
			var u UserResponse
			var userMeta, appMeta []byte
			if err := rows.Scan(&u.ID, &u.Email, &u.Role, &userMeta, &appMeta,
				&u.CreatedAt, &u.UpdatedAt, &u.EmailConfirmedAt, &u.Provider); err != nil {
				log.Error().Err(err).Msg("scan user row")
				continue
			}
			u.UserMetadata = json.RawMessage(userMeta)
			u.AppMetadata = json.RawMessage(appMeta)
			users = append(users, u)
		}
		if err := rows.Err(); err != nil {
			log.Error().Err(err).Msg("iterate user rows")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusOK, users)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: CreateUser — POST /auth/v1/admin/users  (service_role)
// ─────────────────────────────────────────────────────────────────────────────

func AdminCreateUser(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireServiceRole(w, r, d.ServiceRoleKey) {
			return
		}

		var body struct {
			Email        string `json:"email"`
			Password     string `json:"password"`
			Role         string `json:"role"`
			EmailConfirm bool   `json:"email_confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		body.Email = strings.TrimSpace(strings.ToLower(body.Email))
		if _, err := mail.ParseAddress(body.Email); err != nil {
			writeError(w, http.StatusBadRequest, "invalid email address")
			return
		}
		if body.Role == "" {
			body.Role = "authenticated"
		}

		// Validate role against whitelist to prevent privilege escalation.
		validRoles := map[string]bool{"anon": true, "authenticated": true, "service_role": true}
		if !validRoles[body.Role] {
			writeError(w, http.StatusBadRequest, "invalid role")
			return
		}

		var hashedPwd *string
		if body.Password != "" {
			if len(body.Password) < 8 {
				writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
				return
			}
			if len(body.Password) > 256 {
				writeError(w, http.StatusBadRequest, "password must be at most 256 characters")
				return
			}
			h, err := HashPassword(body.Password)
			if err != nil {
				log.Error().Err(err).Msg("admin: hash password")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			hashedPwd = &h
		}

		ctx := r.Context()

		var confirmedAt *string
		if body.EmailConfirm {
			now := time.Now().UTC().Format(time.RFC3339)
			confirmedAt = &now
		}

		var userID, role string
		var createdAt, updatedAt time.Time
		var emailConfirmedAt *time.Time

		err := d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, encrypted_password, role, email_confirmed_at)
			VALUES ($1, $2, $3, $4::timestamptz)
			RETURNING id, role, created_at, updated_at, email_confirmed_at
		`, body.Email, hashedPwd, body.Role, confirmedAt).
			Scan(&userID, &role, &createdAt, &updatedAt, &emailConfirmedAt)
		if err != nil {
			if isUniqueViolation(err) {
				writeError(w, http.StatusConflict, "email already registered")
				return
			}
			log.Error().Err(err).Msg("admin create user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		writeJSON(w, http.StatusCreated, UserResponse{
			ID:               userID,
			Email:            body.Email,
			Role:             role,
			UserMetadata:     json.RawMessage("{}"),
			AppMetadata:      json.RawMessage("{}"),
			CreatedAt:        createdAt,
			UpdatedAt:        updatedAt,
			EmailConfirmedAt: emailConfirmedAt,
			Provider:         "email",
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: DeleteUser — DELETE /auth/v1/admin/users/{id}  (service_role)
// ─────────────────────────────────────────────────────────────────────────────

func AdminDeleteUser(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireServiceRole(w, r, d.ServiceRoleKey) {
			return
		}

		id := chi.URLParam(r, "id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "user id is required")
			return
		}
		// Validate UUID format to prevent injection.
		if _, err := uuid.Parse(id); err != nil {
			writeError(w, http.StatusBadRequest, "invalid user id format")
			return
		}

		tag, err := d.Pool.Exec(r.Context(), `
			DELETE FROM pgstack.users WHERE id = $1
		`, id)
		if err != nil {
			log.Error().Err(err).Str("user_id", id).Msg("admin delete user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if tag.RowsAffected() == 0 {
			writeError(w, http.StatusNotFound, "user not found")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// fetchUserByID loads a full UserResponse from pgstack.users.
func fetchUserByID(ctx context.Context, pool *pgxpool.Pool, userID string) (*UserResponse, error) {
	var u UserResponse
	var userMeta, appMeta []byte

	var providers []string
	err := pool.QueryRow(ctx, `
		SELECT id, email, role,
		       COALESCE(raw_user_meta, '{}')::jsonb,
		       COALESCE(raw_app_meta, '{}')::jsonb,
		       created_at, updated_at, email_confirmed_at, provider,
		       COALESCE(providers, '{}')
		FROM pgstack.users
		WHERE id = $1
	`, userID).Scan(&u.ID, &u.Email, &u.Role, &userMeta, &appMeta,
		&u.CreatedAt, &u.UpdatedAt, &u.EmailConfirmedAt, &u.Provider, &providers)
	if err != nil {
		return nil, err
	}
	// A guest is a never-upgraded anonymous account: the moment any real
	// provider is attached, providers grows and this turns false (INV-B).
	u.IsAnonymous = len(providers) == 1 && providers[0] == "anonymous"

	u.UserMetadata = json.RawMessage(userMeta)
	u.AppMetadata = json.RawMessage(appMeta)
	return &u, nil
}

// isUniqueViolation returns true when err is a PostgreSQL unique_violation (23505).
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	type pgError interface{ SQLState() string }
	if e, ok := err.(pgError); ok {
		return e.SQLState() == "23505"
	}
	return strings.Contains(err.Error(), "23505")
}
