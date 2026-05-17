package auth

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
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
		// Apple's response_mode=form_post returns code/state in the POST
		// body, not the query string. Read query first, then fall back to
		// form values so both transports work without branching on
		// provider here (audit F2, round 14 — the previous version returned
		// 400 before ever calling r.FormValue, so Apple's callback never
		// reached the exchange path).
		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")
		if code == "" {
			code = r.FormValue("code")
		}
		if state == "" {
			state = r.FormValue("state")
		}

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
			// Log only a short fingerprint of the state token, never the full
			// value. The OAuth state token is a CSRF defense; an attacker
			// who reads it from logs can replay a successful authentication.
			// A fingerprint is enough to correlate against other log lines
			// for the same flow without exposing the secret.
			log.Warn().Err(err).Str("state_fp", stateFingerprint(state)).Msg("oauth state not found")
			writeError(w, http.StatusBadRequest, "invalid or expired oauth state")
			return
		}
		if time.Now().UTC().After(expiresAt) {
			writeError(w, http.StatusBadRequest, "oauth session expired")
			return
		}

		redirectURI := d.SiteURL + "/auth/v1/callback"

		var (
			email         string
			emailVerified bool
		)
		switch provider {
		case "google":
			email, emailVerified, err = exchangeGoogle(d, code, verifier, redirectURI)
		case "github":
			email, emailVerified, err = exchangeGitHub(d, code, redirectURI)
		case "apple":
			// form_post body parsing already handled at top of Callback.
			email, emailVerified, err = exchangeApple(d, code, redirectURI)
		case "microsoft":
			email, emailVerified, err = exchangeMicrosoft(d, code, verifier, redirectURI)
		case "oidc":
			email, emailVerified, err = exchangeOIDC(d, code, verifier, redirectURI)
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

		// Account-takeover defense (audit F3):
		//
		// An OAuth provider that returns an unverified or attacker-controlled
		// email could otherwise hijack an existing pgstack.users row simply by
		// completing a successful OAuth flow with that email. We require:
		//
		//   1. The provider explicitly asserted email_verified=true for this
		//      flow. If not, refuse the login outright. Apple, Google, GitHub,
		//      Microsoft and standards-compliant OIDC IdPs all carry a verified
		//      claim; if a provider does not, it cannot be used here.
		//   2. When merging into an existing pgstack.users row that was created
		//      via email+password but never verified (email_confirmed_at IS
		//      NULL), refuse the merge. Otherwise an unverified password signup
		//      becomes a free OAuth on-ramp for an attacker who simply knows
		//      the victim's email.
		//
		// On success, email_confirmed_at is set only on INSERT — never elevated
		// on UPDATE.
		if !emailVerified {
			log.Warn().Str("provider", provider).Msg("oauth refused: provider did not assert email_verified")
			redirectURL := fmt.Sprintf("%s#error=access_denied&error_description=%s",
				d.SiteURL, url.QueryEscape("provider did not verify email ownership"))
			http.Redirect(w, r, redirectURL, http.StatusFound)
			return
		}

		// Upsert user, appending this provider to the providers array. Refuse
		// to merge into an unverified existing account.
		var (
			userID         string
			role           string
			conflictBlock  bool
		)
		err = d.Pool.QueryRow(ctx, `
			INSERT INTO pgstack.users (email, role, provider, providers, email_confirmed_at)
			VALUES ($1, 'authenticated', $2, ARRAY[$2], now())
			ON CONFLICT (email) DO UPDATE
			  SET providers = CASE
			        WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.providers
			        WHEN $2 = ANY(pgstack.users.providers) THEN pgstack.users.providers
			        ELSE array_append(pgstack.users.providers, $2)
			      END,
			      updated_at = CASE
			        WHEN pgstack.users.email_confirmed_at IS NULL THEN pgstack.users.updated_at
			        ELSE now()
			      END
			RETURNING id, role, (email_confirmed_at IS NULL) AS conflict_block
		`, email, provider).Scan(&userID, &role, &conflictBlock)
		if err != nil {
			log.Error().Err(err).Msg("upsert oauth user")
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if conflictBlock {
			log.Warn().Str("provider", provider).
				Msg("oauth refused: existing account with this email is not verified — possible takeover attempt")
			redirectURL := fmt.Sprintf("%s#error=access_denied&error_description=%s",
				d.SiteURL, url.QueryEscape("an unverified account already exists for this email; complete verification or contact support"))
			http.Redirect(w, r, redirectURL, http.StatusFound)
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

// exchangeGoogle exchanges an authorization code for a Google access token,
// fetches the user's email via the userinfo endpoint, and returns the email
// plus Google's email_verified assertion. Per audit F3 the caller refuses
// the login when verified is false.
func exchangeGoogle(d *Deps, code, verifier, redirectURI string) (string, bool, error) {
	tokenResp, err := httpPostForm("https://oauth2.googleapis.com/token", url.Values{
		"code":          {code},
		"client_id":     {d.GoogleClientID},
		"client_secret": {d.GoogleClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", false, fmt.Errorf("google token exchange: %w", err)
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", false, fmt.Errorf("google token exchange: no access_token in response")
	}

	var userInfo map[string]any
	if err := httpGetJSON("https://www.googleapis.com/oauth2/v3/userinfo", accessToken, &userInfo); err != nil {
		return "", false, fmt.Errorf("google userinfo: %w", err)
	}

	email, _ := userInfo["email"].(string)
	if email == "" {
		return "", false, fmt.Errorf("google userinfo: email not present")
	}
	verified := claimTrue(userInfo["email_verified"])
	return strings.ToLower(strings.TrimSpace(email)), verified, nil
}

// claimTrue normalises the bool/string forms of an email_verified claim.
// OIDC technically requires bool but real providers occasionally send "true".
func claimTrue(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true")
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeGitHub exchanges an authorization code for a GitHub access token,
// then fetches the primary verified email. GitHub only returns emails the
// user has explicitly verified in their account settings — we still require
// the .verified flag per row before accepting one.
func exchangeGitHub(d *Deps, code, redirectURI string) (string, bool, error) {
	tokenResp, err := httpPostForm("https://github.com/login/oauth/access_token", url.Values{
		"code":          {code},
		"client_id":     {d.GitHubClientID},
		"client_secret": {d.GitHubClientSecret},
		"redirect_uri":  {redirectURI},
	})
	if err != nil {
		return "", false, fmt.Errorf("github token exchange: %w", err)
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", false, fmt.Errorf("github token exchange: no access_token in response")
	}

	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := httpGetJSON("https://api.github.com/user/emails", accessToken, &emails); err != nil {
		return "", false, fmt.Errorf("github user emails: %w", err)
	}

	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), true, nil
		}
	}
	for _, e := range emails {
		if e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), true, nil
		}
	}
	return "", false, fmt.Errorf("github user emails: no verified email found")
}

// ─────────────────────────────────────────────────────────────────────────────
// Apple OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeApple exchanges an authorization code for an Apple id_token JWT
// and returns the email plus Apple's email_verified assertion. The id_token
// is now JWKS-verified (audit F3 round 14): we fetch Apple's public keys
// from https://appleid.apple.com/auth/keys, check the ES256 signature
// against the matching kid, and validate iss/aud/exp before reading the
// email claim. email_verified still gates acceptance (Apple's private-
// relay emails come back unverified).
func exchangeApple(d *Deps, code, redirectURI string) (string, bool, error) {
	tokenResp, err := httpPostForm("https://appleid.apple.com/auth/token", url.Values{
		"code":          {code},
		"client_id":     {d.AppleClientID},
		"client_secret": {generateAppleClientSecret(d)},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return "", false, fmt.Errorf("apple token exchange: %w", err)
	}

	idToken, ok := tokenResp["id_token"].(string)
	if !ok || idToken == "" {
		return "", false, fmt.Errorf("apple token exchange: no id_token in response")
	}

	email, verified, err := verifyIDToken(
		idToken,
		"https://appleid.apple.com/auth/keys",
		IssuerEquals("https://appleid.apple.com"),
		d.AppleClientID,
	)
	if err != nil {
		return "", false, fmt.Errorf("apple id_token: %w", err)
	}
	return strings.ToLower(strings.TrimSpace(email)), verified, nil
}

// appleSecretCache memoises the generated Apple client-secret JWT. Apple permits
// a lifetime of up to 6 months; we use 1 hour and regenerate shortly before
// expiry so a long-lived process never presents a stale secret.
var (
	appleSecretMu      sync.Mutex
	appleSecretValue   string
	appleSecretExpires time.Time
)

// generateAppleClientSecret returns the ES256-signed JWT that Apple requires in
// place of a static client_secret. Claims: iss=team_id, sub=client_id,
// aud=https://appleid.apple.com; the signing key's key_id goes in the header.
// d.ApplePrivateKey is the PEM-encoded PKCS#8 EC private key (the .p8 file).
//
// Back-compat: if d.ApplePrivateKey is already a pre-generated client_secret
// JWT (not PEM), it is returned verbatim. Returns "" on misconfiguration — the
// token exchange then fails cleanly with Apple's own error.
func generateAppleClientSecret(d *Deps) string {
	if looksLikeJWT(d.ApplePrivateKey) {
		return strings.TrimSpace(d.ApplePrivateKey)
	}

	appleSecretMu.Lock()
	defer appleSecretMu.Unlock()

	if appleSecretValue != "" && time.Now().Before(appleSecretExpires.Add(-5*time.Minute)) {
		return appleSecretValue
	}

	key, err := parseApplePrivateKey(d.ApplePrivateKey)
	if err != nil {
		log.Error().Err(err).Msg("apple: cannot parse private key for client_secret")
		return ""
	}

	now := time.Now()
	exp := now.Add(1 * time.Hour)
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": d.AppleTeamID,
		"iat": now.Unix(),
		"exp": exp.Unix(),
		"aud": "https://appleid.apple.com",
		"sub": d.AppleClientID,
	})
	tok.Header["kid"] = d.AppleKeyID

	signed, err := tok.SignedString(key)
	if err != nil {
		log.Error().Err(err).Msg("apple: cannot sign client_secret JWT")
		return ""
	}

	appleSecretValue = signed
	appleSecretExpires = exp
	return signed
}

// looksLikeJWT reports whether s is a compact-serialised JWT (three dot-separated
// segments, no PEM armour) rather than a PEM private key.
func looksLikeJWT(s string) bool {
	s = strings.TrimSpace(s)
	return strings.Count(s, ".") == 2 && !strings.Contains(s, "BEGIN")
}

// parseApplePrivateKey decodes a PEM-encoded PKCS#8 EC private key (the contents
// of the Apple .p8 file) into an *ecdsa.PrivateKey.
func parseApplePrivateKey(pemKey string) (*ecdsa.PrivateKey, error) {
	pemKey = strings.TrimSpace(pemKey)
	if pemKey == "" {
		return nil, errors.New("APPLE_PRIVATE_KEY is not configured")
	}
	block, _ := pem.Decode([]byte(pemKey))
	if block == nil {
		return nil, errors.New("APPLE_PRIVATE_KEY is not valid PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKCS#8 key: %w", err)
	}
	ecKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("APPLE_PRIVATE_KEY is not an EC private key")
	}
	return ecKey, nil
}

// extractEmailFromJWT decodes a JWT's payload without verifying its signature
// and returns the email plus the email_verified claim. The "skip signature
// verification" stance is only safe when the token arrived directly from the
// provider's token endpoint over TLS in response to an authenticated client
// exchange — the TLS handshake authenticates the provider, and the response
// body is bound to that connection. Callers MUST refuse the login when the
// verified flag is false (closes audit F3 silent-trust path).
func extractEmailFromJWT(token string) (string, bool, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false, fmt.Errorf("invalid JWT format")
	}

	payload := parts[1]
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		decoded, err = base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return "", false, fmt.Errorf("decode JWT payload: %w", err)
		}
	}

	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return "", false, fmt.Errorf("parse JWT claims: %w", err)
	}

	email, ok := claims["email"].(string)
	if !ok || email == "" {
		return "", false, fmt.Errorf("email not present in JWT claims")
	}
	return email, claimTrue(claims["email_verified"]), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft OAuth exchange
// ─────────────────────────────────────────────────────────────────────────────

// exchangeMicrosoft exchanges an authorization code for a Microsoft access
// token and returns the email plus whether the provider asserted it as
// verified. Microsoft's id_token carries an xms_edov / email_verified claim
// for personal accounts and tenant-validated work accounts; falls back to
// Graph /me only as a last resort and treats those as unverified (Graph
// has no email-verified field — work accounts with a verified domain are
// trustworthy, personal accounts are not, and there's no way to tell).
func exchangeMicrosoft(d *Deps, code, verifier, redirectURI string) (string, bool, error) {
	tokenResp, err := httpPostForm("https://login.microsoftonline.com/common/oauth2/v2.0/token", url.Values{
		"code":          {code},
		"client_id":     {d.MicrosoftClientID},
		"client_secret": {d.MicrosoftClientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", false, fmt.Errorf("microsoft token exchange: %w", err)
	}

	// Audit F3 round 14: JWKS-verify the id_token. Microsoft's "common"
	// tenant rewrites the iss to https://login.microsoftonline.com/{tenant}/v2.0
	// per user, so the validator accepts any issuer under that prefix
	// rather than a single literal. The JWKS endpoint for common still
	// returns the union of tenant-signing keys, so kid resolution works.
	if idToken, ok := tokenResp["id_token"].(string); ok && idToken != "" {
		email, verified, err := verifyIDToken(
			idToken,
			"https://login.microsoftonline.com/common/discovery/v2.0/keys",
			func(iss string) bool {
				return strings.HasPrefix(iss, "https://login.microsoftonline.com/") &&
					strings.HasSuffix(iss, "/v2.0")
			},
			d.MicrosoftClientID,
		)
		if err == nil && email != "" {
			return strings.ToLower(strings.TrimSpace(email)), verified, nil
		}
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", false, fmt.Errorf("microsoft token exchange: no access_token in response")
	}

	var userInfo map[string]any
	if err := httpGetJSON("https://graph.microsoft.com/v1.0/me", accessToken, &userInfo); err != nil {
		return "", false, fmt.Errorf("microsoft graph /me: %w", err)
	}

	email, _ := userInfo["mail"].(string)
	if email == "" {
		email, _ = userInfo["userPrincipalName"].(string)
	}
	if email == "" {
		return "", false, fmt.Errorf("microsoft graph: email not found in user profile")
	}
	// Graph carries no verified claim; do not assert verification here.
	return strings.ToLower(strings.TrimSpace(email)), false, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic OIDC exchange
// ─────────────────────────────────────────────────────────────────────────────

// oidcConfig caches the discovered OpenID Configuration for the session.
type oidcConfig struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
	JWKSURI               string `json:"jwks_uri"`
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

// exchangeOIDC exchanges an authorization code using the OIDC discovery
// document. Per OIDC core, the id_token MUST contain email_verified when
// email is present; this implementation propagates that flag rather than
// silently trusting any address the IdP hands back. If a non-compliant
// provider omits the claim, the login is treated as unverified — callers
// will refuse it.
func exchangeOIDC(d *Deps, code, verifier, redirectURI string) (string, bool, error) {
	cfg, err := discoverOIDC(d.OIDCIssuerURL)
	if err != nil {
		return "", false, err
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
		return "", false, fmt.Errorf("oidc token exchange: %w", err)
	}

	// Audit F3 round 14: JWKS-verify the id_token when both jwks_uri and
	// issuer are present in the discovery document (required by the OIDC
	// core spec).
	if idToken, ok := tokenResp["id_token"].(string); ok && idToken != "" && cfg.JWKSURI != "" && cfg.Issuer != "" {
		email, verified, err := verifyIDToken(
			idToken,
			cfg.JWKSURI,
			IssuerEquals(cfg.Issuer),
			d.OIDCClientID,
		)
		if err == nil && email != "" {
			return strings.ToLower(strings.TrimSpace(email)), verified, nil
		}
	}

	accessToken, ok := tokenResp["access_token"].(string)
	if !ok || accessToken == "" {
		return "", false, fmt.Errorf("oidc token exchange: no access_token in response")
	}

	if cfg.UserinfoEndpoint != "" {
		var userInfo map[string]any
		if err := httpGetJSON(cfg.UserinfoEndpoint, accessToken, &userInfo); err != nil {
			return "", false, fmt.Errorf("oidc userinfo: %w", err)
		}
		email, _ := userInfo["email"].(string)
		if email != "" {
			return strings.ToLower(strings.TrimSpace(email)), claimTrue(userInfo["email_verified"]), nil
		}
	}

	return "", false, fmt.Errorf("oidc: email not found in id_token or userinfo")
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

// stateFingerprint returns the first 8 hex chars of SHA-256(state), enough
// to correlate log lines for the same OAuth flow without exposing the
// CSRF-defense secret in logs.
func stateFingerprint(state string) string {
	if state == "" {
		return "(empty)"
	}
	sum := sha256.Sum256([]byte(state))
	return hex.EncodeToString(sum[:4])
}
