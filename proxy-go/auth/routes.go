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

// generateTokenPair mints a JWT access token and an opaque refresh token,
// persists the refresh token in pgstack.refresh_tokens, and returns both.
func generateTokenPair(ctx context.Context, d *Deps, userID, email, role string) (access, refresh string, err error) {
	access, err = GenerateToken(userID, role, email, d.JWTSecret, d.AccessTokenExpirySecs)
	if err != nil {
		return "", "", fmt.Errorf("generate access token: %w", err)
	}

	refresh = generateOpaqueToken()
	familyID := uuid.New().String()
	expiresAt := time.Now().UTC().Add(time.Duration(d.RefreshTokenExpiryDays) * 24 * time.Hour)

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO pgstack.refresh_tokens (user_id, token, family_id, expires_at)
		VALUES ($1, $2, $3, $4)
	`, userID, refresh, familyID, expiresAt)
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
		if len(body.Password) < 6 {
			writeError(w, http.StatusBadRequest, "password must be at least 6 characters")
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

		err = d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, encrypted_password, raw_user_meta)
			VALUES ($1, $2, $3)
			RETURNING id, role, created_at, updated_at, email_confirmed_at
		`, body.Email, hashed, userMeta).Scan(&userID, &role, &createdAt, &updatedAt, &emailConfirmedAt)
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
				INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
				VALUES ($1, $2, 'email_verification', $3)
			`, userID, tok, exp)
			if err != nil {
				log.Error().Err(err).Msg("create email verification token")
			}

			if d.Mailer != nil {
				verifyURL := fmt.Sprintf("%s/auth/v1/verify?token=%s", d.SiteURL, tok)
				htmlBody := fmt.Sprintf(`<p>Verify your email: <a href="%s">%s</a></p>`, verifyURL, verifyURL)
				if err := d.Mailer.Send(body.Email, "Verify your email", htmlBody); err != nil {
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
		       created_at, updated_at, email_confirmed_at, provider
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
	)
	err := row.Scan(&userID, &encryptedPwd, &role, &userMeta, &appMeta, &createdAt, &updatedAt, &emailConfirmedAt, &provider)
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

	access, refresh, err := generateTokenPair(ctx, d, userID, email, role)
	if err != nil {
		log.Error().Err(err).Msg("generate token pair (password grant)")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  access,
		TokenType:    "bearer",
		ExpiresIn:    d.AccessTokenExpirySecs,
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
		},
	})
}

func handleRefreshGrant(w http.ResponseWriter, r *http.Request, ctx context.Context, d *Deps, refreshToken string) {
	if refreshToken == "" {
		writeError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	// Look up the token.
	var (
		tokenID  string
		userID   string
		familyID string
		revoked  bool
		expiresAt time.Time
	)
	err := d.Pool.QueryRow(ctx, `
		SELECT id, user_id, family_id, revoked, expires_at
		FROM pgstack.refresh_tokens
		WHERE token = $1
	`, refreshToken).Scan(&tokenID, &userID, &familyID, &revoked, &expiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeError(w, http.StatusUnauthorized, "invalid refresh token")
			return
		}
		log.Error().Err(err).Msg("lookup refresh token")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Reuse detection: if the presented token is already revoked, revoke the
	// entire family (the token has been stolen or replayed).
	if revoked {
		_, _ = d.Pool.Exec(ctx, `
			DELETE FROM pgstack.refresh_tokens WHERE family_id = $1
		`, familyID)
		writeError(w, http.StatusUnauthorized, "refresh token reuse detected — please log in again")
		return
	}

	if time.Now().UTC().After(expiresAt) {
		writeError(w, http.StatusUnauthorized, "refresh token expired")
		return
	}

	// Rotate: mark old token revoked, insert new one with same family.
	newRefresh := generateOpaqueToken()
	newExpiry := time.Now().UTC().Add(time.Duration(d.RefreshTokenExpiryDays) * 24 * time.Hour)

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		log.Error().Err(err).Msg("begin refresh rotation tx")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		UPDATE pgstack.refresh_tokens SET revoked = true WHERE id = $1
	`, tokenID)
	if err != nil {
		log.Error().Err(err).Msg("revoke old refresh token")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO pgstack.refresh_tokens (user_id, token, family_id, expires_at)
		VALUES ($1, $2, $3, $4)
	`, userID, newRefresh, familyID, newExpiry)
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

	access, err := GenerateToken(userID, user.Role, user.Email, d.JWTSecret, d.AccessTokenExpirySecs)
	if err != nil {
		log.Error().Err(err).Msg("generate access token for refresh grant")
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{
		AccessToken:  access,
		TokenType:    "bearer",
		ExpiresIn:    d.AccessTokenExpirySecs,
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

		if body.Email != nil {
			newEmail := strings.TrimSpace(strings.ToLower(*body.Email))
			if _, err := mail.ParseAddress(newEmail); err != nil {
				writeError(w, http.StatusBadRequest, "invalid email address")
				return
			}
			_, err := d.Pool.Exec(ctx, `
				UPDATE pgstack.users SET email = $1, updated_at = now() WHERE id = $2
			`, newEmail, claims.Sub)
			if err != nil {
				if isUniqueViolation(err) {
					writeError(w, http.StatusConflict, "email already in use")
					return
				}
				log.Error().Err(err).Msg("update user email")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}

		if body.Password != nil {
			if len(*body.Password) < 6 {
				writeError(w, http.StatusBadRequest, "password must be at least 6 characters")
				return
			}
			hashed, err := HashPassword(*body.Password)
			if err != nil {
				log.Error().Err(err).Msg("hash new password")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
			_, err = d.Pool.Exec(ctx, `
				UPDATE pgstack.users SET encrypted_password = $1, updated_at = now() WHERE id = $2
			`, hashed, claims.Sub)
			if err != nil {
				log.Error().Err(err).Msg("update user password")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}

		if len(body.Data) > 0 && string(body.Data) != "null" {
			_, err := d.Pool.Exec(ctx, `
				UPDATE pgstack.users SET raw_user_meta = $1, updated_at = now() WHERE id = $2
			`, body.Data, claims.Sub)
			if err != nil {
				log.Error().Err(err).Msg("update user metadata")
				writeError(w, http.StatusInternalServerError, "internal error")
				return
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
			INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
			VALUES ($1, $2, 'recovery', $3)
		`, userID, tok, exp)
		if err != nil {
			log.Error().Err(err).Msg("create recovery token")
			writeJSON(w, http.StatusOK, map[string]string{"message": safeMsg})
			return
		}

		if d.Mailer != nil {
			resetURL := fmt.Sprintf("%s/auth/v1/recover/confirm?token=%s", d.SiteURL, tok)
			htmlBody := fmt.Sprintf(`<p>Reset your password: <a href="%s">%s</a></p><p>This link expires in 1 hour.</p>`, resetURL, resetURL)
			if err := d.Mailer.Send(body.Email, "Reset your password", htmlBody); err != nil {
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
		if len(body.Password) < 6 {
			writeError(w, http.StatusBadRequest, "password must be at least 6 characters")
			return
		}

		ctx := r.Context()

		var tokenID, userID string
		var usedAt *time.Time
		var expiresAt time.Time
		err := d.Pool.QueryRow(ctx, `
			SELECT id, user_id, used_at, expires_at
			FROM pgstack.email_tokens
			WHERE token = $1 AND token_type = 'recovery'
		`, body.Token).Scan(&tokenID, &userID, &usedAt, &expiresAt)
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("lookup recovery token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if usedAt != nil {
			writeError(w, http.StatusBadRequest, "token already used")
			return
		}
		if time.Now().UTC().After(expiresAt) {
			writeError(w, http.StatusBadRequest, "token expired")
			return
		}

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

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.users SET encrypted_password = $1, updated_at = now() WHERE id = $2
		`, hashed, userID)
		if err != nil {
			log.Error().Err(err).Msg("update password after recovery")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1
		`, tokenID)
		if err != nil {
			log.Error().Err(err).Msg("mark recovery token used")
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
			INSERT INTO pgstack.email_tokens (user_id, token, token_type, expires_at)
			VALUES ($1, $2, 'magiclink', $3)
		`, userID, tok, exp)
		if err != nil {
			log.Error().Err(err).Msg("create magiclink token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if d.Mailer != nil {
			verifyURL := fmt.Sprintf("%s/auth/v1/magiclink/verify?token=%s", d.SiteURL, tok)
			htmlBody := fmt.Sprintf(`<p>Sign in: <a href="%s">%s</a></p><p>This link expires in 1 hour.</p>`, verifyURL, verifyURL)
			if err := d.Mailer.Send(body.Email, "Your sign-in link", htmlBody); err != nil {
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

		var tokenID, userID string
		var usedAt *time.Time
		var expiresAt time.Time
		err := d.Pool.QueryRow(ctx, `
			SELECT id, user_id, used_at, expires_at
			FROM pgstack.email_tokens
			WHERE token = $1 AND token_type = 'magiclink'
		`, tok).Scan(&tokenID, &userID, &usedAt, &expiresAt)
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("lookup magiclink token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if usedAt != nil {
			writeError(w, http.StatusBadRequest, "token already used")
			return
		}
		if time.Now().UTC().After(expiresAt) {
			writeError(w, http.StatusBadRequest, "token expired")
			return
		}

		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin magiclink verify tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1
		`, tokenID)
		if err != nil {
			log.Error().Err(err).Msg("mark magiclink token used")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		// Also confirm email.
		_, err = tx.Exec(ctx, `
			UPDATE pgstack.users
			SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
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

		var tokenID, userID string
		var usedAt *time.Time
		var expiresAt time.Time
		err := d.Pool.QueryRow(ctx, `
			SELECT id, user_id, used_at, expires_at
			FROM pgstack.email_tokens
			WHERE token = $1 AND token_type = 'email_verification'
		`, tok).Scan(&tokenID, &userID, &usedAt, &expiresAt)
		if err != nil {
			if err == pgx.ErrNoRows {
				writeError(w, http.StatusBadRequest, "invalid or expired token")
				return
			}
			log.Error().Err(err).Msg("lookup email verification token")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if usedAt != nil {
			writeError(w, http.StatusBadRequest, "token already used")
			return
		}
		if time.Now().UTC().After(expiresAt) {
			writeError(w, http.StatusBadRequest, "token expired")
			return
		}

		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			log.Error().Err(err).Msg("begin email verify tx")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.users
			SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
			WHERE id = $1
		`, userID)
		if err != nil {
			log.Error().Err(err).Msg("confirm email")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		_, err = tx.Exec(ctx, `
			UPDATE pgstack.email_tokens SET used_at = now() WHERE id = $1
		`, tokenID)
		if err != nil {
			log.Error().Err(err).Msg("mark email token used")
			writeError(w, http.StatusInternalServerError, "internal error")
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

		var hashedPwd *string
		if body.Password != "" {
			if len(body.Password) < 6 {
				writeError(w, http.StatusBadRequest, "password must be at least 6 characters")
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

	err := pool.QueryRow(ctx, `
		SELECT id, email, role,
		       COALESCE(raw_user_meta, '{}')::jsonb,
		       COALESCE(raw_app_meta, '{}')::jsonb,
		       created_at, updated_at, email_confirmed_at, provider
		FROM pgstack.users
		WHERE id = $1
	`, userID).Scan(&u.ID, &u.Email, &u.Role, &userMeta, &appMeta,
		&u.CreatedAt, &u.UpdatedAt, &u.EmailConfirmedAt, &u.Provider)
	if err != nil {
		return nil, err
	}

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
