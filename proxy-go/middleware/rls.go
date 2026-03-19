package middleware

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// maxClaimsJSONLen is the maximum length of the JWT claims JSON string passed
// to set_config. Matches the Rust proxy's 8 KB limit.
const maxClaimsJSONLen = 8192

// RequestClaims represents the authenticated identity resolved for a request.
// Extracted from JWT, anon key, service role key, or defaulted to anon.
type RequestClaims struct {
	// Role is the PG role to SET LOCAL (anon, authenticated, service_role).
	Role string
	// Sub is the user UUID extracted from the JWT sub claim.
	Sub string
	// Email is the email from the JWT claims, if present.
	Email string
	// ClaimsJSON is the full JWT claims serialised to JSON, used for
	// the request.jwt.claims GUC.
	ClaimsJSON string
}

// anonClaims returns claims representing the anonymous role.
func anonClaims() RequestClaims {
	return RequestClaims{
		Role:       "anon",
		ClaimsJSON: `{"role":"anon"}`,
	}
}

// serviceRoleClaims returns claims representing the service role (bypasses RLS).
func serviceRoleClaims() RequestClaims {
	return RequestClaims{
		Role:       "service_role",
		ClaimsJSON: `{"role":"service_role"}`,
	}
}

// RLSConfig carries the subset of Config needed by RLS resolution so that the
// middleware package does not import the main package (avoiding cycles).
type RLSConfig struct {
	JWTSecret      string
	AnonKey        string
	ServiceRoleKey string
}

// ResolveClaims resolves the request identity from HTTP headers.
//
// Resolution order (matches the Rust proxy exactly):
//  1. Bearer token == SERVICE_ROLE_KEY  → service_role
//  2. apikey header == SERVICE_ROLE_KEY → service_role
//  3. Bearer token is a valid JWT       → authenticated claims
//  4. Bearer token == ANON_KEY          → anon
//  5. apikey header == ANON_KEY         → anon
//  6. Auth enabled but no valid creds   → 401
//  7. Auth disabled (JWTSecret == "")   → anon pass-through
func ResolveClaims(r *http.Request, cfg RLSConfig) (RequestClaims, error) {
	authHeader := r.Header.Get("Authorization")
	apikeyHeader := r.Header.Get("apikey")

	var bearerToken string
	if strings.HasPrefix(authHeader, "Bearer ") {
		bearerToken = authHeader[len("Bearer "):]
	}

	// 1. Bearer token == service_role_key (constant-time)
	if bearerToken != "" && cfg.ServiceRoleKey != "" {
		if constantTimeEq(bearerToken, cfg.ServiceRoleKey) {
			return serviceRoleClaims(), nil
		}
	}

	// 2. apikey header == service_role_key (constant-time)
	if apikeyHeader != "" && cfg.ServiceRoleKey != "" {
		if constantTimeEq(apikeyHeader, cfg.ServiceRoleKey) {
			return serviceRoleClaims(), nil
		}
	}

	// 3. Bearer token as JWT (validated before anon key fallback so that JWT
	// auth takes priority over a matching anon key — the Supabase client sends
	// both headers simultaneously).
	if bearerToken != "" && cfg.JWTSecret != "" {
		if claims, err := validateJWT(bearerToken, cfg.JWTSecret); err == nil {
			return claimsFromJWT(claims), nil
		}
		// Not a valid JWT: fall through to anon key checks.
	}

	// 4. Bearer token == anon_key (constant-time)
	if bearerToken != "" && cfg.AnonKey != "" {
		if constantTimeEq(bearerToken, cfg.AnonKey) {
			return anonClaims(), nil
		}
	}

	// 5. apikey header == anon_key (constant-time)
	if apikeyHeader != "" && cfg.AnonKey != "" {
		if constantTimeEq(apikeyHeader, cfg.AnonKey) {
			return anonClaims(), nil
		}
	}

	// 6. Auth enabled but no valid credentials → 401.
	if cfg.JWTSecret != "" {
		return RequestClaims{}, errors.New("authentication required")
	}

	// 7. Auth disabled → anon pass-through.
	return anonClaims(), nil
}

// constantTimeEq compares two strings in constant time (length equality check
// is non-constant-time, but acceptable for keys that are always >= 32 chars).
func constantTimeEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ConstantTimeEqExported is the exported version of constantTimeEq, available
// to other packages (e.g. routes) that need to compare API keys.
func ConstantTimeEqExported(a, b string) bool {
	return constantTimeEq(a, b)
}

// validateJWT parses and validates a signed JWT using the HS256 algorithm.
//
// Expiry is validated when the exp claim is present (rejected if expired).
// Tokens without an exp claim are accepted only if iat is within 24 hours.
func validateJWT(tokenStr, secret string) (jwt.MapClaims, error) {
	// Parse without requiring exp so we can accept tokens that omit it.
	// jwt/v5 by default validates exp when present, and does NOT require it.
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"HS256"}),
	)

	claims := jwt.MapClaims{}
	token, err := parser.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	})
	if err != nil {
		return nil, fmt.Errorf("JWT validation failed: %w", err)
	}
	if !token.Valid {
		return nil, errors.New("JWT validation failed: invalid token")
	}

	// Enforce max token age for tokens without an exp claim (H1 fix).
	if _, hasExp := claims["exp"]; !hasExp {
		iat, _ := claims["iat"].(float64)
		if iat == 0 {
			return nil, errors.New("JWT validation failed: token must have exp or iat claim")
		}
		if time.Since(time.Unix(int64(iat), 0)) > 24*time.Hour {
			return nil, errors.New("JWT validation failed: token without exp expired (iat too old)")
		}
	}

	return claims, nil
}

// claimsFromJWT builds RequestClaims from validated JWT MapClaims.
//
// SECURITY: JWTs are never allowed to escalate to service_role via the JWT
// payload. Only a direct API key match grants service_role.
func claimsFromJWT(c jwt.MapClaims) RequestClaims {
	sub, _ := c["sub"].(string)

	role, _ := c["role"].(string)
	if role == "" {
		role = "authenticated"
	}
	if role == "service_role" {
		// SECURITY: demote JWT-claimed service_role to authenticated.
		// Only a direct API key match grants service_role — mirrors Rust proxy behaviour.
		role = "authenticated"
	}

	email, _ := c["email"].(string)

	// Build a sanitised claims JSON for the request.jwt.claims GUC.
	claimsJSON, _ := json.Marshal(c)

	return RequestClaims{
		Role:       role,
		Sub:        sub,
		Email:      email,
		ClaimsJSON: string(claimsJSON),
	}
}

// RLSTransaction begins a pgx transaction with RLS context (role + JWT claims).
//
// It executes:
//
//	SET LOCAL ROLE <role>
//	SELECT set_config('request.jwt.claims', '<json>', true)
//
// The caller must Commit or Rollback the returned transaction.
// SET LOCAL values are automatically reverted when the transaction ends.
func RLSTransaction(ctx context.Context, pool *pgxpool.Pool, claims RequestClaims) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}

	// SET LOCAL ROLE — only whitelisted roles are permitted (SQL injection prevention).
	roleSQLMap := map[string]string{
		"authenticated": "SET LOCAL ROLE authenticated",
		"service_role":  "SET LOCAL ROLE service_role",
		"anon":          "SET LOCAL ROLE anon",
	}
	roleSQL, ok := roleSQLMap[claims.Role]
	if !ok {
		roleSQL = "SET LOCAL ROLE anon"
	}

	if _, err = tx.Exec(ctx, roleSQL); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("SET LOCAL ROLE: %w", err)
	}

	// Reject oversized claims instead of silently truncating. Truncation could
	// produce malformed JSON that breaks downstream RLS policies.
	claimsJSON := claims.ClaimsJSON
	if len(claimsJSON) > maxClaimsJSONLen {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("JWT claims too large (%d bytes, max %d)", len(claimsJSON), maxClaimsJSONLen)
	}

	if _, err = tx.Exec(ctx, "SELECT set_config('request.jwt.claims', $1, true)", claimsJSON); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set_config request.jwt.claims: %w", err)
	}

	return tx, nil
}

