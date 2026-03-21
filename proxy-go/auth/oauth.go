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

// supportedProviders is the set of OAuth providers we support.
var supportedProviders = map[string]bool{
	"google":    true,
	"github":    true,
	"apple":     true,
	"microsoft": true,
	"oidc":      true,
}

// Authorize initiates an OAuth flow by redirecting to the provider's auth URL.
// Query param: ?provider=google|github|apple|microsoft|oidc
func Authorize(d *Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provider := strings.ToLower(r.URL.Query().Get("provider"))
		if !supportedProviders[provider] {
			writeError(w, http.StatusBadRequest, "provider must be one of: google, github, apple, microsoft, oidc")
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

		case "apple":
			q := url.Values{}
			q.Set("client_id", d.AppleClientID)
			q.Set("redirect_uri", redirectURI)
			q.Set("response_type", "code")
			q.Set("scope", "email name")
			q.Set("state", state)
			q.Set("response_mode", "form_post")
			authURL = "https://appleid.apple.com/auth/authorize?" + q.Encode()

		case "microsoft":
			q := url.Values{}
			q.Set("client_id", d.MicrosoftClientID)
			q.Set("redirect_uri", redirectURI)
			q.Set("response_type", "code")
			q.Set("scope", "openid email profile")
			q.Set("state", state)
			q.Set("code_challenge", challenge)
			q.Set("code_challenge_method", "S256")
			authURL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + q.Encode()

		case "oidc":
			// Generic OIDC: discover authorization endpoint from issuer
			oidcAuthURL, err := discoverOIDCAuthEndpoint(d.OIDCIssuerURL)
			if err != nil {
				log.Error().Err(err).Msg("oidc discovery failed")
				writeError(w, http.StatusInternalServerError, "OIDC discovery failed")
				return
			}
			q := url.Values{}
			q.Set("client_id", d.OIDCClientID)
			q.Set("redirect_uri", redirectURI)
			q.Set("response_type", "code")
			q.Set("scope", "openid email profile")
			q.Set("state", state)
			q.Set("code_challenge", challenge)
			q.Set("code_challenge_method", "S256")
			authURL = oidcAuthURL + "?" + q.Encode()
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

		// Handle provider-side user denial (e.g. ?error=access_denied).
		if oauthErr := r.URL.Query().Get("error"); oauthErr != "" {
			desc := r.URL.Query().Get("error_description")
			if desc == "" {
				desc = oauthErr
			}
			redirectURL := fmt.Sprintf("%s#error=%s&error_description=%s",
				d.SiteURL, url.QueryEscape(oauthErr), url.QueryEscape(desc))
			http.Redirect(w, r, redirectURL, http.StatusFound)
			return
		}

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
		case "apple":
			// Apple sends code via form_post; also check POST body
			if code == "" {
				code = r.FormValue("code")
			}
			email, err = exchangeApple(d, code, redirectURI)
		case "microsoft":
			email, err = exchangeMicrosoft(d, code, verifier, redirectURI)
		case "oidc":
			email, err = exchangeOIDC(d, code, verifier, redirectURI)
		default:
			writeError(w, http.StatusBadRequest, "unknown provider")
			return
		}
		if err != nil {
			log.Error().Err(err).Str("provider", provider).Msg("oauth exchange")
			redirectURL := fmt.Sprintf("%s#error=server_error&error_description=%s",
				d.SiteURL, url.QueryEscape("authentication failed"))
			http.Redirect(w, r, redirectURL, http.StatusFound)
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
// Apple OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeApple exchanges an authorization code for an Apple id_token JWT,
// then extracts the email from the JWT claims (Apple uses id_token, not userinfo).
func exchangeApple(d *Deps, code, redirectURI string) (string, error) {
	tokenResp, err := httpPostForm("https://appleid.apple.com/auth/token", url.Values{
		"code":          {code},
		"client_id":     {d.AppleClientID},
		"client_secret": {generateAppleClientSecret(d)},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return "", fmt.Errorf("apple token exchange: %w", err)
	}

	idToken, ok := tokenResp["id_token"].(string)
	if !ok || idToken == "" {
		return "", fmt.Errorf("apple token exchange: no id_token in response")
	}

	// Decode the id_token JWT payload (Apple tokens are signed but we trust
	// them here because we got them directly from Apple's token endpoint over TLS).
	email, err := extractEmailFromJWT(idToken)
	if err != nil {
		return "", fmt.Errorf("apple id_token: %w", err)
	}

	return strings.ToLower(strings.TrimSpace(email)), nil
}

// generateAppleClientSecret creates a short-lived JWT signed with the Apple private key.
// Apple requires a client_secret JWT instead of a static secret.
func generateAppleClientSecret(d *Deps) string {
	// For a full implementation, this would generate a JWT signed with ES256
	// using the team_id, key_id, and private key. For now, return the private
	// key directly (works if the caller pre-generates the client_secret JWT).
	return d.ApplePrivateKey
}

// extractEmailFromJWT decodes a JWT without verification and extracts the email claim.
// This is safe when the token was received directly from the provider over TLS.
func extractEmailFromJWT(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid JWT format")
	}

	// Decode the payload (part 1)
	payload := parts[1]
	// Add padding if needed
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		// Try without padding (base64url)
		decoded, err = base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("decode JWT payload: %w", err)
		}
	}

	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return "", fmt.Errorf("parse JWT claims: %w", err)
	}

	email, ok := claims["email"].(string)
	if !ok || email == "" {
		return "", fmt.Errorf("email not present in JWT claims")
	}
	return email, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeMicrosoft exchanges an authorization code for a Microsoft access token,
// then fetches the user's email via the Microsoft Graph API.
func exchangeMicrosoft(d *Deps, code, verifier, redirectURI string) (string, error) {
	tokenResp, err := httpPostForm("https://login.microsoftonline.com/common/oauth2/v2.0/token", url.Values{
		"code":          {code},
		"client_id":     {d.MicrosoftClientID},
		"client_secret": {d.MicrosoftClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", fmt.Errorf("microsoft token exchange: %w", err)
	}

	// Microsoft returns an id_token with email — try that first
	if idToken, ok := tokenResp["id_token"].(string); ok && idToken != "" {
		if email, err := extractEmailFromJWT(idToken); err == nil && email != "" {
			return strings.ToLower(strings.TrimSpace(email)), nil
		}
	}

	// Fallback to access_token + Graph API
	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", fmt.Errorf("microsoft token exchange: no access_token in response")
	}

	var userInfo map[string]any
	if err := httpGetJSON("https://graph.microsoft.com/v1.0/me", accessToken, &userInfo); err != nil {
		return "", fmt.Errorf("microsoft graph /me: %w", err)
	}

	email, _ := userInfo["mail"].(string)
	if email == "" {
		email, _ = userInfo["userPrincipalName"].(string)
	}
	if email == "" {
		return "", fmt.Errorf("microsoft graph: email not found in user profile")
	}

	return strings.ToLower(strings.TrimSpace(email)), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic OIDC exchange
// ─────────────────────────────────────────────────────────────────────────────

// oidcConfig caches the discovered OpenID Configuration for the session.
type oidcConfig struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
}

// discoverOIDCAuthEndpoint fetches the OIDC discovery document and returns
// the authorization_endpoint.
func discoverOIDCAuthEndpoint(issuerURL string) (string, error) {
	cfg, err := discoverOIDC(issuerURL)
	if err != nil {
		return "", err
	}
	return cfg.AuthorizationEndpoint, nil
}

// discoverOIDC fetches the OpenID Configuration from the issuer's well-known endpoint.
func discoverOIDC(issuerURL string) (*oidcConfig, error) {
	if issuerURL == "" {
		return nil, fmt.Errorf("OIDC_ISSUER_URL is not configured")
	}

	wellKnown := strings.TrimRight(issuerURL, "/") + "/.well-known/openid-configuration"
	var cfg oidcConfig
	if err := httpGetJSON(wellKnown, "", &cfg); err != nil {
		return nil, fmt.Errorf("OIDC discovery from %s: %w", wellKnown, err)
	}

	if cfg.AuthorizationEndpoint == "" || cfg.TokenEndpoint == "" {
		return nil, fmt.Errorf("OIDC discovery: missing required endpoints")
	}
	return &cfg, nil
}

// exchangeOIDC exchanges an authorization code using the OIDC discovery document.
func exchangeOIDC(d *Deps, code, verifier, redirectURI string) (string, error) {
	cfg, err := discoverOIDC(d.OIDCIssuerURL)
	if err != nil {
		return "", err
	}

	tokenResp, err := httpPostForm(cfg.TokenEndpoint, url.Values{
		"code":          {code},
		"client_id":     {d.OIDCClientID},
		"client_secret": {d.OIDCClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", fmt.Errorf("oidc token exchange: %w", err)
	}

	// Try id_token first
	if idToken, ok := tokenResp["id_token"].(string); ok && idToken != "" {
		if email, err := extractEmailFromJWT(idToken); err == nil && email != "" {
			return strings.ToLower(strings.TrimSpace(email)), nil
		}
	}

	// Fallback to userinfo endpoint
	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", fmt.Errorf("oidc token exchange: no access_token in response")
	}

	if cfg.UserinfoEndpoint != "" {
		var userInfo map[string]any
		if err := httpGetJSON(cfg.UserinfoEndpoint, accessToken, &userInfo); err != nil {
			return "", fmt.Errorf("oidc userinfo: %w", err)
		}

		email, _ := userInfo["email"].(string)
		if email != "" {
			return strings.ToLower(strings.TrimSpace(email)), nil
		}
	}

	return "", fmt.Errorf("oidc: email not found in id_token or userinfo")
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
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
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
