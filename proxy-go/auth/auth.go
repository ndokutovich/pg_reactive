// Package auth implements all user authentication HTTP handlers for pgstack-proxy-go.
// It is intentionally self-contained: it does not import the main package to avoid
// circular imports. The caller passes a *Deps struct that carries the pool, secrets,
// and mailer interface.
package auth

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MailerIface is the sending capability the auth package requires.
// The concrete *Mailer in the main package satisfies this interface.
type MailerIface interface {
	Send(to, subject, htmlBody string) error
	SendEmailVerification(to, verifyURL string) error
	SendPasswordReset(to, resetURL string) error
	SendMagicLink(to, linkURL string) error
}

// Deps carries every dependency the auth handlers need.
// All fields are required unless marked optional.
type Deps struct {
	Pool           *pgxpool.Pool
	JWTSecret      string
	AnonKey        string
	ServiceRoleKey string

	AccessTokenExpirySecs  int
	RefreshTokenExpiryDays int

	// Anonymous signin — see Config.AllowAnonymousSignin. When false, the
	// /auth/v1/anonymous handler returns 503 (default-deny).
	AllowAnonymousSignin bool
	AnonymousJWTTTLSecs  int

	Mailer                   MailerIface // optional; nil → no email sent
	RequireEmailVerification bool
	SiteURL                  string

	// OAuth
	GoogleClientID     string
	GoogleClientSecret string
	GitHubClientID     string
	GitHubClientSecret string

	// Apple OAuth
	AppleClientID  string
	AppleTeamID    string
	AppleKeyID     string
	ApplePrivateKey string

	// Microsoft OAuth
	MicrosoftClientID     string
	MicrosoftClientSecret string

	// Generic OIDC
	OIDCClientID     string
	OIDCClientSecret string
	OIDCIssuerURL    string
}

// AuthResponse is returned by endpoints that issue a session (signup, token grant,
// magic-link verify, OAuth callback).
type AuthResponse struct {
	AccessToken  string       `json:"access_token"`
	TokenType    string       `json:"token_type"`
	ExpiresIn    int          `json:"expires_in"`
	RefreshToken string       `json:"refresh_token"`
	User         UserResponse `json:"user"`
}

// UserResponse is the public representation of a pgstack.users row.
type UserResponse struct {
	ID               string          `json:"id"`
	Email            string          `json:"email"`
	Role             string          `json:"role"`
	UserMetadata     json.RawMessage `json:"user_metadata"`
	AppMetadata      json.RawMessage `json:"app_metadata"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
	EmailConfirmedAt *time.Time      `json:"email_confirmed_at,omitempty"`
	Provider         string          `json:"provider,omitempty"`
	IsAnonymous      bool            `json:"is_anonymous,omitempty"`
}

// writeError writes {"error":"<msg>"} with the given HTTP status.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]string{"error": msg})
	_, _ = w.Write(body)
}

// writeJSON serialises v as JSON with the given HTTP status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
