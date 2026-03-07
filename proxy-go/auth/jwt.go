package auth

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims represents the payload of an access token issued by this proxy.
type Claims struct {
	Sub   string `json:"sub"`
	Role  string `json:"role"`
	Email string `json:"email,omitempty"`
	Iat   int64  `json:"iat,omitempty"`
	Exp   int64  `json:"exp,omitempty"`
}

// GenerateToken creates a signed HS256 JWT for the given subject.
// expirySecs ≤ 0 means no expiry claim is embedded.
func GenerateToken(sub, role, email, secret string, expirySecs int) (string, error) {
	now := time.Now().UTC()

	mc := jwt.MapClaims{
		"sub":  sub,
		"role": role,
		"iat":  now.Unix(),
	}
	if email != "" {
		mc["email"] = email
	}
	if expirySecs > 0 {
		mc["exp"] = now.Add(time.Duration(expirySecs) * time.Second).Unix()
	}

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, mc)
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}
	return signed, nil
}

// ValidateToken parses and verifies a HS256 JWT.
// It tolerates tokens without an exp claim (backwards compatibility).
// A 60-second clock leeway is applied.
func ValidateToken(tokenStr, secret string) (*Claims, error) {
	// We parse with MapClaims so we can manually handle the optional exp field.
	tok, err := jwt.ParseWithClaims(
		tokenStr,
		jwt.MapClaims{},
		func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return []byte(secret), nil
		},
		jwt.WithLeeway(60*time.Second),
		// Do NOT pass WithExpirationRequired — exp is optional for backwards compat.
	)
	if err != nil {
		// jwt/v5 returns an error even on expired tokens, but we still want to
		// surface the claims; callers can decide how strict to be.  For this
		// proxy we treat any parse/sig error as fatal.
		return nil, fmt.Errorf("invalid token: %w", err)
	}
	if !tok.Valid {
		return nil, fmt.Errorf("token is not valid")
	}

	mc, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("unexpected claims type")
	}

	c := &Claims{}

	if v, ok := mc["sub"].(string); ok {
		c.Sub = v
	}
	if v, ok := mc["role"].(string); ok {
		c.Role = v
	}
	if v, ok := mc["email"].(string); ok {
		c.Email = v
	}
	if v, ok := mc["iat"].(float64); ok {
		c.Iat = int64(v)
	}
	if v, ok := mc["exp"].(float64); ok {
		c.Exp = int64(v)
	}

	if c.Sub == "" {
		return nil, fmt.Errorf("token missing sub claim")
	}

	// Enforce max token age for tokens without an exp claim.
	if c.Exp == 0 {
		if c.Iat == 0 {
			return nil, fmt.Errorf("token must have exp or iat claim")
		}
		if time.Since(time.Unix(c.Iat, 0)) > 24*time.Hour {
			return nil, fmt.Errorf("token without exp expired (iat too old)")
		}
	}

	return c, nil
}

// ExtractToken pulls a raw JWT string from the request.
// Priority order: Authorization: Bearer → apikey header → ?token= query param.
// Returns "" if no token is found.
func ExtractToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); auth != "" {
		if strings.HasPrefix(auth, "Bearer ") {
			return strings.TrimPrefix(auth, "Bearer ")
		}
	}
	if key := r.Header.Get("apikey"); key != "" {
		return key
	}
	return r.URL.Query().Get("token")
}

// requireJWT extracts and validates the Bearer JWT from r.
// On failure it writes a 401 JSON response and returns nil.
// On success it returns the parsed *Claims.
func requireJWT(w http.ResponseWriter, r *http.Request, secret string) *Claims {
	raw := r.Header.Get("Authorization")
	if !strings.HasPrefix(raw, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "missing authorization header")
		return nil
	}
	tokenStr := strings.TrimPrefix(raw, "Bearer ")

	claims, err := ValidateToken(tokenStr, secret)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired token")
		return nil
	}
	return claims
}

// requireServiceRole checks that the Bearer token equals the service-role key.
// Writes 403 and returns false on failure.
func requireServiceRole(w http.ResponseWriter, r *http.Request, serviceRoleKey string) bool {
	raw := r.Header.Get("Authorization")
	if !strings.HasPrefix(raw, "Bearer ") {
		writeError(w, http.StatusForbidden, "service role required")
		return false
	}
	provided := strings.TrimPrefix(raw, "Bearer ")

	// Constant-time comparison to prevent timing attacks.
	if !constantTimeEqual(provided, serviceRoleKey) {
		writeError(w, http.StatusForbidden, "invalid service role key")
		return false
	}
	return true
}

// constantTimeEqual compares two strings in constant time using crypto/subtle.
func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
