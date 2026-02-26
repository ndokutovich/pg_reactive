package auth

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// ─────────────────────────────────────────────────────────────────────────────
// PKCE / state helpers
// ─────────────────────────────────────────────────────────────────────────────

// generateState returns 32 random bytes hex-encoded, used as the OAuth CSRF state.
func generateState() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// generateCodeVerifier returns 32 random bytes as a base64url-encoded PKCE verifier.
func generateCodeVerifier() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// codeChallenge derives the S256 PKCE challenge from a verifier.
func codeChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorize — GET /auth/v1/authorize
// ─────────────────────────────────────────────────────────────────────────────

// Authorize initiates an OAuth flow by redirecting to the provider's auth URL.
// Query param: ?provider=google|github
func Authorize(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provider := strings.ToLower(r.URL.Query().Get("provider"))
		if provider != "google" && provider != "github" {
			writeError(w, http.StatusBadRequest, "provider must be 'google' or 'github'")
			return
		}

		state := generateState()
		verifier := generateCodeVerifier()
		challenge := codeChallenge(verifier)
		expiresAt := time.Now().UTC().Add(10 * time.Minute)

		_, err := d.Pool.Exec(r.Context(), `
			INSERT INTO pgstack.oauth_sessions (state, code_verifier, provider, expires_at)
			VALUES ($1, $2, $3, $4)
		`, state, verifier, provider, expiresAt)
		if err != nil {
			log.Error().Err(err).Msg("store oauth session")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		redirectURI := d.SiteURL + "/auth/v1/callback"
		var authURL string

		switch provider {
		case "google":
			q := url.Values{}
			q.Set("client_id", d.GoogleClientID)
			q.Set("redirect_uri", redirectURI)
			q.Set("response_type", "code")
			q.Set("scope", "openid email profile")
			q.Set("state", state)
			q.Set("code_challenge", challenge)
			q.Set("code_challenge_method", "S256")
			authURL = "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode()

		case "github":
			q := url.Values{}
			q.Set("client_id", d.GitHubClientID)
			q.Set("redirect_uri", redirectURI)
			q.Set("scope", "user:email")
			q.Set("state", state)
			// GitHub does not support PKCE — state alone is the CSRF protection.
			authURL = "https://github.com/login/oauth/authorize?" + q.Encode()
		}

		http.Redirect(w, r, authURL, http.StatusFound)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback — GET /auth/v1/callback
// ─────────────────────────────────────────────────────────────────────────────

// Callback handles the OAuth provider redirect, exchanges the code for a session,
// and redirects the browser to SiteURL with the token in the fragment.
func Callback(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")

		if code == "" || state == "" {
			writeError(w, http.StatusBadRequest, "code and state are required")
			return
		}

		ctx := r.Context()

		// Validate & consume the session (one-time use).
		var verifier, provider string
		var expiresAt time.Time
		err := d.Pool.QueryRow(ctx, `
			DELETE FROM pgstack.oauth_sessions
			WHERE state = $1
			RETURNING code_verifier, provider, expires_at
		`, state).Scan(&verifier, &provider, &expiresAt)
		if err != nil {
			log.Warn().Err(err).Str("state", state).Msg("oauth state not found")
			writeError(w, http.StatusBadRequest, "invalid or expired oauth state")
			return
		}
		if time.Now().UTC().After(expiresAt) {
			writeError(w, http.StatusBadRequest, "oauth session expired")
			return
		}

		redirectURI := d.SiteURL + "/auth/v1/callback"

		var email string
		switch provider {
		case "google":
			email, err = exchangeGoogle(d, code, verifier, redirectURI)
		case "github":
			email, err = exchangeGitHub(d, code, redirectURI)
		default:
			writeError(w, http.StatusBadRequest, "unknown provider")
			return
		}
		if err != nil {
			log.Error().Err(err).Str("provider", provider).Msg("oauth exchange")
			writeError(w, http.StatusBadGateway, "oauth provider error")
			return
		}

		// Upsert user, appending this provider to the providers array.
		var userID, role string
		err = d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, role, provider, providers, email_confirmed_at)
			VALUES ($1, 'authenticated', $2, ARRAY[$2], now())
			ON CONFLICT (email) DO UPDATE
			  SET providers = CASE
			        WHEN $2 = ANY(pgstack.users.providers) THEN pgstack.users.providers
			        ELSE array_append(pgstack.users.providers, $2)
			      END,
			      updated_at = now()
			RETURNING id, role
		`, email, provider).Scan(&userID, &role)
		if err != nil {
			log.Error().Err(err).Msg("upsert oauth user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		access, refresh, err := generateTokenPair(ctx, d, userID, email, role)
		if err != nil {
			log.Error().Err(err).Msg("generate token pair for oauth callback")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}

		redirectURL := fmt.Sprintf("%s#access_token=%s&refresh_token=%s&token_type=bearer&expires_in=%d",
			d.SiteURL, access, refresh, d.AccessTokenExpirySecs)
		http.Redirect(w, r, redirectURL, http.StatusFound)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeGoogle exchanges an authorization code for a Google access token, then
// fetches the user's email via the userinfo endpoint. Returns the verified email.
func exchangeGoogle(d *Deps, code, verifier, redirectURI string) (string, error) {
	// Step 1: exchange code for tokens.
	tokenResp, err := httpPostForm("https://oauth2.googleapis.com/token", url.Values{
		"code":          {code},
		"client_id":     {d.GoogleClientID},
		"client_secret": {d.GoogleClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", fmt.Errorf("google token exchange: %w", err)
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", fmt.Errorf("google token exchange: no access_token in response")
	}

	// Step 2: fetch user info.
	var userInfo map[string]any
	if err := httpGetJSON("https://www.googleapis.com/oauth2/v3/userinfo", accessToken, &userInfo); err != nil {
		return "", fmt.Errorf("google userinfo: %w", err)
	}

	email, _ := userInfo["email"].(string)
	if email == "" {
		return "", fmt.Errorf("google userinfo: email not present")
	}

	return strings.ToLower(strings.TrimSpace(email)), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeGitHub exchanges an authorization code for a GitHub access token, then
// fetches the primary verified email. Returns the email.
func exchangeGitHub(d *Deps, code, redirectURI string) (string, error) {
	// Step 1: exchange code for access token.
	tokenResp, err := httpPostForm("https://github.com/login/oauth/access_token", url.Values{
		"code":          {code},
		"client_id":     {d.GitHubClientID},
		"client_secret": {d.GitHubClientSecret},
		"redirect_uri":  {redirectURI},
	})
	if err != nil {
		return "", fmt.Errorf("github token exchange: %w", err)
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", fmt.Errorf("github token exchange: no access_token in response")
	}

	// Step 2: fetch emails (user:email scope).
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := httpGetJSON("https://api.github.com/user/emails", accessToken, &emails); err != nil {
		return "", fmt.Errorf("github user emails: %w", err)
	}

	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), nil
		}
	}

	// Fallback: first verified email.
	for _, e := range emails {
		if e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), nil
		}
	}

	return "", fmt.Errorf("github user emails: no verified email found")
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP utility helpers
// ─────────────────────────────────────────────────────────────────────────────

// httpPostForm sends an application/x-www-form-urlencoded POST and returns the
// JSON-decoded response body as a map. The Accept: application/json header is
// set so providers that return form-encoded bodies by default (GitHub) return JSON.
func httpPostForm(endpoint string, values url.Values) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewBufferString(values.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("POST %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("POST %s returned %d: %s", endpoint, resp.StatusCode, raw)
	}

	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("decode response from %s: %w", endpoint, err)
	}
	return result, nil
}

// httpGetJSON sends a GET request with a Bearer access token and JSON-decodes the
// response body into target.
func httpGetJSON(endpoint, accessToken string, target any) error {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "pgstack-proxy-go/1.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 300 {
		return fmt.Errorf("GET %s returned %d: %s", endpoint, resp.StatusCode, raw)
	}

	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode response from %s: %w", endpoint, err)
	}
	return nil
}
