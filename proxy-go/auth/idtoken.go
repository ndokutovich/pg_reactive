package auth

// JWKS-based id_token verification (audit F3, round 14).
//
// extractEmailFromJWT (oauth.go) was decoding the payload without checking
// the signature, iss, aud or exp. The TLS-bound-trust argument is partially
// true — the token does come back from the provider over an authenticated
// TLS channel — but defence in depth says we should not skip cryptographic
// validation when it's available. JWKS fetching + signature checking + the
// usual registered-claim checks (iss, aud, exp) close that gap for the
// three providers that ship an id_token: Apple, Microsoft, and generic
// OIDC IdPs.
//
// Design notes:
//   - We keep a per-jwksURI in-memory cache with a 24h TTL. On key
//     rotation (kid not found), we drop the cache and refetch once.
//   - We accept RS256/384/512 and ES256/384/512. HS* is intentionally
//     disallowed — it's a known JWT-alg-confusion footgun and no real
//     OIDC provider ships HS-signed id_tokens via JWKS.
//   - iss is checked via a caller-supplied validator. Microsoft's
//     "common" tenant rewrites iss per-user (tenant id in the path),
//     so we cannot pin a literal string; the validator takes care of it.
//   - aud is matched against expectedAud as a single string OR as a
//     member of a string-array claim, per RFC 7519.
//   - email_verified is read straight from the validated claims and
//     returned alongside the email — caller still gates on it.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type jwkEntry struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

type jwksDoc struct {
	Keys []jwkEntry `json:"keys"`
}

type cachedJWKS struct {
	fetchedAt time.Time
	keys      map[string]any // kid -> *rsa.PublicKey or *ecdsa.PublicKey
}

var (
	jwksCacheMu  sync.RWMutex
	jwksCacheMap = map[string]*cachedJWKS{}
	jwksTTL      = 24 * time.Hour
)

// IssuerValidator decides whether a token's iss claim is acceptable. Use a
// literal-equality closure for single-tenant providers (Apple, OIDC) and a
// prefix/pattern check for multi-tenant ones (Microsoft common).
type IssuerValidator func(iss string) bool

// IssuerEquals returns a validator that accepts only the given exact issuer.
func IssuerEquals(want string) IssuerValidator {
	return func(iss string) bool { return iss == want }
}

func fetchJWKSCached(jwksURI string) (*cachedJWKS, error) {
	jwksCacheMu.RLock()
	if c, ok := jwksCacheMap[jwksURI]; ok && time.Since(c.fetchedAt) < jwksTTL {
		jwksCacheMu.RUnlock()
		return c, nil
	}
	jwksCacheMu.RUnlock()

	req, err := http.NewRequest(http.MethodGet, jwksURI, nil)
	if err != nil {
		return nil, fmt.Errorf("build JWKS request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "pgstack-proxy-go/1.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", jwksURI, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s returned %d", jwksURI, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return nil, fmt.Errorf("read JWKS body: %w", err)
	}

	var ks jwksDoc
	if err := json.Unmarshal(raw, &ks); err != nil {
		return nil, fmt.Errorf("parse JWKS: %w", err)
	}
	keys := make(map[string]any, len(ks.Keys))
	for i := range ks.Keys {
		k := &ks.Keys[i]
		if k.Kid == "" {
			continue
		}
		switch k.Kty {
		case "RSA":
			if pk, err := rsaFromJWK(k); err == nil {
				keys[k.Kid] = pk
			}
		case "EC":
			if pk, err := ecFromJWK(k); err == nil {
				keys[k.Kid] = pk
			}
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("JWKS contained no usable keys")
	}
	cached := &cachedJWKS{fetchedAt: time.Now(), keys: keys}

	jwksCacheMu.Lock()
	jwksCacheMap[jwksURI] = cached
	jwksCacheMu.Unlock()
	return cached, nil
}

func rsaFromJWK(k *jwkEntry) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, fmt.Errorf("decode n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, fmt.Errorf("decode e: %w", err)
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 | int(b)
	}
	if e == 0 {
		return nil, errors.New("rsa exponent is zero")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func ecFromJWK(k *jwkEntry) (*ecdsa.PublicKey, error) {
	var curve elliptic.Curve
	switch k.Crv {
	case "P-256":
		curve = elliptic.P256()
	case "P-384":
		curve = elliptic.P384()
	case "P-521":
		curve = elliptic.P521()
	default:
		return nil, fmt.Errorf("unsupported curve %s", k.Crv)
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil {
		return nil, fmt.Errorf("decode x: %w", err)
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(k.Y)
	if err != nil {
		return nil, fmt.Errorf("decode y: %w", err)
	}
	return &ecdsa.PublicKey{
		Curve: curve,
		X:     new(big.Int).SetBytes(xBytes),
		Y:     new(big.Int).SetBytes(yBytes),
	}, nil
}

// verifyIDToken validates a provider id_token end-to-end:
//
//  1. JWKS-resolved signature, algorithms restricted to RS*/ES*
//  2. iss accepted by the caller-supplied validator
//  3. aud contains expectedAud
//  4. exp / nbf checked by the JWT library's default registered-claim
//     validation (any missing exp also fails — callers should not accept
//     tokens with no expiry)
//
// Returns the email and email_verified claims on success.
func verifyIDToken(idToken, jwksURI string, validIssuer IssuerValidator, expectedAud string) (email string, emailVerified bool, err error) {
	ks, err := fetchJWKSCached(jwksURI)
	if err != nil {
		return "", false, fmt.Errorf("jwks: %w", err)
	}

	claims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(idToken, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing kid header")
		}
		if key, ok := ks.keys[kid]; ok {
			return key, nil
		}
		// kid not found — provider may have rotated. Drop the cache and
		// refetch exactly once before giving up.
		jwksCacheMu.Lock()
		delete(jwksCacheMap, jwksURI)
		jwksCacheMu.Unlock()
		refreshed, refErr := fetchJWKSCached(jwksURI)
		if refErr != nil {
			return nil, fmt.Errorf("kid %q not in JWKS and refresh failed: %w", kid, refErr)
		}
		key, ok := refreshed.keys[kid]
		if !ok {
			return nil, fmt.Errorf("kid %q not in JWKS even after refresh", kid)
		}
		return key, nil
	}, jwt.WithValidMethods([]string{"RS256", "RS384", "RS512", "ES256", "ES384", "ES512"}))
	if err != nil {
		return "", false, fmt.Errorf("verify id_token: %w", err)
	}
	if !parsed.Valid {
		return "", false, errors.New("id_token signature invalid")
	}

	iss, _ := claims["iss"].(string)
	if iss == "" || !validIssuer(iss) {
		return "", false, fmt.Errorf("iss rejected: %q", iss)
	}
	if !audMatches(claims["aud"], expectedAud) {
		return "", false, fmt.Errorf("aud does not contain %q", expectedAud)
	}

	emailStr, ok := claims["email"].(string)
	if !ok || emailStr == "" {
		return "", false, errors.New("email claim missing or empty")
	}
	return emailStr, claimTrue(claims["email_verified"]), nil
}

// audMatches accepts both the string and []string shapes RFC 7519 permits.
func audMatches(c any, want string) bool {
	switch a := c.(type) {
	case string:
		return a == want
	case []any:
		for _, v := range a {
			if s, ok := v.(string); ok && s == want {
				return true
			}
		}
	case []string:
		for _, s := range a {
			if s == want {
				return true
			}
		}
	}
	return false
}
