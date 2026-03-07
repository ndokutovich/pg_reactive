# Security Audit Report — pgStack (pg_reactive)

**Date:** 2026-03-07
**Scope:** Full stack — C extension, Go proxy, TypeScript SDK, Docker, CI/CD
**Method:** Static analysis (4 parallel specialized auditors) + dependency review

---

## Executive Summary

The codebase demonstrates strong security fundamentals: parameterized SQL queries throughout, identifier quoting via `QuoteIdent`, role whitelisting for `SET LOCAL ROLE`, Argon2id password hashing, refresh token rotation with family-based reuse detection, and non-root Docker containers. However, **4 Critical**, **11 High**, **14 Medium**, and **10 Low** findings were identified across all layers.

**Top 3 urgent fixes:**
1. Embedded JS (goja) `db.query()` bypasses all RLS — any edge function runs SQL as superuser
2. Timing attack on service role key comparison in `auth/jwt.go`
3. C extension returns shared memory pointers after lock release (use-after-free race)

---

## Findings by Severity

### CRITICAL (4)

| ID | Component | Finding | File | OWASP |
|----|-----------|---------|------|-------|
| C1 | Go Proxy | **`constantTimeEqual` in auth/jwt.go leaks key length via timing** — custom implementation short-circuits on length mismatch; `strings.Compare` dummy is not constant-time. The middleware package correctly uses `crypto/subtle.ConstantTimeCompare` | `proxy-go/auth/jwt.go:156-167` | A02 |
| C2 | Go Proxy | **Embedded JS `db.query()` bypasses RLS** — goja VM acquires raw pool connection, executes SQL without `SET LOCAL ROLE` or `request.jwt.claims`. Any edge function effectively runs as superuser | `proxy-go/functions/goja.go:59-107` | A01 |
| C3 | C Extension | **`pgr_dep_find` returns shared memory pointer after lock release** — another backend can `HASH_REMOVE` the entry concurrently, causing use-after-free. Same pattern in `pgr_dep_add` | `ext/src/dependency.c:234-251, 99-203` | Memory Safety |
| C4 | C Extension | **User-supplied query_text executed verbatim via SPI** — `pgr.subscribe()` does not validate that the query is a pure SELECT. CTE with DML (`WITH x AS (DELETE ... RETURNING *) SELECT ...`) would execute side effects | `ext/src/recompute.c:223-226, 455-490` | A03 |

### HIGH (11)

| ID | Component | Finding | File |
|----|-----------|---------|------|
| H1 | Go Proxy | **JWTs without `exp` claim accepted indefinitely** — a compromised token lives forever. Comment says "backwards compat" | `proxy-go/auth/jwt.go:49-61` |
| H2 | Go Proxy | **`ENABLE_SQL_ENDPOINT` accepts unauthenticated arbitrary SQL** — dev compose enables by default, no rate limit, no query limit | `proxy-go/routes/sql.go:36-42` |
| H3 | Go Proxy | **Rate limiting bypassed via `X-Forwarded-For` spoofing** — `realIP()` trusts proxy headers unconditionally. No trusted proxy config | `proxy-go/middleware/rate_limit.go:76-92` |
| H4 | Go Proxy | **No rate limiting on `/auth/v1/recover`, `/auth/v1/magiclink`** — allows email bombing and brute-force of reset tokens | `proxy-go/main.go:329-333` |
| H5 | Go Proxy | **Rate limiter unbounded memory growth** — per-IP map never evicts stale entries. Rotating IPs cause OOM | `proxy-go/middleware/rate_limit.go:13-55` |
| H6 | Go Proxy | **OAuth error details leak internal info to browser** — `err.Error()` passed into redirect URL fragment | `proxy-go/auth/oauth.go:163-166` |
| H7 | Go Proxy | **ClaimsJSON truncation produces invalid JSON** — `truncateUTF8` can cut mid-JSON, breaking RLS policies that parse it | `proxy-go/middleware/rls.go:228-258` |
| H8 | Go Proxy | **Batch template injection in query strings** — resolved `{{op.field}}` values can inject filter operators via `&` | `proxy-go/rest/template.go:16-41` |
| H9 | Go Proxy | **No body size limit on Edge Functions** — route group lacks `BodyLimit`, `io.ReadAll` without restriction | `proxy-go/main.go:441-447` |
| H10 | C Extension | **JSON column name injection in NOTIFY payload** — column names not escaped (double-quoted PG identifiers can contain special chars) | `ext/src/recompute.c:414` |
| H11 | C Extension | **`%ld` format for `int64` on Windows** — `long` is 32-bit on Windows, truncating counter values | `ext/src/pg_reactive.c:806-838` |
| H12 | SDK | **Session tokens stored in localStorage** — `useAuth` hook persists access+refresh tokens where XSS can steal them | `sdk/src/react.ts:36-51` |
| H13 | Infrastructure | **`golang.org/x/crypto` v0.27.0 and `golang.org/x/net` v0.21.0 are outdated** — known CVE fixes in later versions | `proxy-go/go.mod` |

### MEDIUM (14)

| ID | Component | Finding | File |
|----|-----------|---------|------|
| M1 | Go Proxy | **WebSocket `CheckOrigin` always returns true** — allows cross-site WebSocket hijacking regardless of CORS config | `proxy-go/realtime/ws.go:18-24` |
| M2 | Go Proxy | **No HSTS header** — missing `Strict-Transport-Security` when TLS is enabled | `proxy-go/middleware/security.go` |
| M3 | Go Proxy | **Refresh tokens stored as plaintext in DB** — database compromise yields usable tokens | `proxy-go/auth/routes.go:55-58` |
| M4 | Go Proxy | **`PublicSecurityHeaders` allows `unsafe-inline` scripts** — weakens XSS protection on user SPAs | `proxy-go/middleware/public_security.go:14-22` |
| M5 | Go Proxy | **Dev default secrets pass validation** — `dev-only-jwt-secret-...` is 48 chars, passes min-length check | `docker-compose.yml:33` |
| M6 | Go Proxy | **Password grant doesn't check `email_confirmed_at`** — unverified users can log in when `RequireEmailVerification=true` | `proxy-go/auth/routes.go:212-281` |
| M7 | Go Proxy | **Admin `CreateUser` accepts arbitrary role** — no validation against role whitelist | `proxy-go/auth/routes.go:975-1060` |
| M8 | Go Proxy | **Error messages leak table/column/function names** — enables schema enumeration via probing | `proxy-go/rest/handlers.go:26,130,264` |
| M9 | Go Proxy | **Catalog refresh errors leak internal details** — DB connection errors can contain hostnames | `proxy-go/routes/catalog_refresh.go:31` |
| M10 | Go Proxy | **No goja execution timeout** — infinite loop in embedded function blocks goroutine forever | `proxy-go/functions/goja.go:133` |
| M11 | Go Proxy | **Production port binds to all interfaces** — should default to `127.0.0.1` | `docker-compose.prod.yml:98` |
| M12 | C Extension | **Buffer overread when `pgr_dep_find_by_table` returns count > 256** — callers iterate past stack array bounds | `ext/src/pg_reactive.c:607` |
| M13 | SQL | **`pgstack.refresh_tokens`, `email_tokens`, `oauth_sessions` lack RLS** — no defense-in-depth if grants change | `docker/init.sql:47-76` |
| M14 | SQL | **`edge_functions.env_vars` stores secrets as plaintext JSONB** — visible in WAL, backups, pg_stat_statements | `docker/init.sql:236` |

### LOW (10)

| ID | Finding | File |
|----|---------|------|
| L1 | OAuth state token logged at WARN level | `proxy-go/auth/oauth.go:141` |
| L2 | CORS allows credentials with reflected origin in dev mode | `proxy-go/middleware/cors.go:26-34` |
| L3 | Expired email tokens never cleaned up | `proxy-go/auth/routes.go` |
| L4 | Missing `Permissions-Policy` header | `proxy-go/middleware/security.go` |
| L5 | Missing `X-XSS-Protection: 0` header | `proxy-go/middleware/security.go` |
| L6 | Docker images not pinned to SHA256 digest | `proxy-go/Dockerfile` |
| L7 | `gopkg.in/gomail.v2` unmaintained (2016) | `proxy-go/go.mod` |
| L8 | `pgr.stats()` and `pgr.get_subscriptions()` executable by PUBLIC | `ext/pg_reactive--0.1.sql:49-55` |
| L9 | Update handler logs SQL and parameters (potential PII leak) | `proxy-go/rest/handlers.go:312` |
| L10 | SDK `RealtimeChannel` doesn't validate channel name | `sdk/src/index.ts:295` |

---

## Positive Security Controls (Already Done Well)

| Control | Status | Notes |
|---------|--------|-------|
| Parameterized SQL queries | Excellent | `$N::type` binding used consistently across all CRUD, auth, storage |
| Identifier quoting | Good | `QuoteIdent()` doubles internal quotes, used for all dynamic identifiers |
| Role whitelisting for SET LOCAL ROLE | Excellent | Hardcoded map prevents SQL injection via role name |
| Password hashing | Excellent | Argon2id with OWASP-recommended params (19 MiB, 2 iter) |
| Refresh token rotation | Excellent | Family-based reuse detection, revokes entire family on replay |
| JWT service_role demotion | Excellent | JWT claims cannot escalate to service_role — only API key match |
| IS operator value whitelist | Good | Only NULL/TRUE/FALSE/UNKNOWN allowed |
| Update/Delete require filters | Good | Prevents accidental full-table mutations |
| Non-root Docker container | Good | Proxy runs as dedicated `appuser` |
| File upload size limit | Good | `MaxBytesReader` applied before multipart parsing |
| Directory traversal protection | Good | `filepath.Clean` + prefix check in PublicSPA |
| SPI memory context | Good | `initStringInfo` before `SPI_connect` consistently |
| Production PG auth | Good | `scram-sha-256` in docker-compose.prod.yml |
| .env files gitignored | Good | `.env` and `.env.local` in .gitignore |

---

## Remediation Priority

### Phase 1 — Immediate (before any production deployment)

1. **C1**: Replace `constantTimeEqual` in `auth/jwt.go` with `subtle.ConstantTimeCompare`
2. **C2**: Add RLS transaction context to goja `db.query()` using caller's claims
3. **H2**: Add validation: reject `ENABLE_SQL_ENDPOINT=true` when `JWT_SECRET` is set
4. **H3**: Add `TRUSTED_PROXIES` config; use `r.RemoteAddr` when no trusted proxy
5. **H4**: Apply rate limiter to all auth endpoints (recover, magiclink, recover/confirm)
6. **H5**: Add periodic cleanup goroutine for rate limiter map
7. **H9**: Add `BodyLimit` middleware to Edge Functions route group
8. **H13**: Update `golang.org/x/crypto` and `golang.org/x/net` to latest

### Phase 2 — Before public beta

9. **C3/C4**: Fix C extension shared memory pointer returns; add SELECT-only validation
10. **H1**: Add max token age check for JWTs without `exp`
11. **H6**: Replace `err.Error()` in OAuth redirect with generic message
12. **H7**: Reject oversized claims instead of truncating
13. **H8**: URL-encode template-resolved values in batch query strings
14. **M1**: Validate WebSocket `Origin` against `AllowedOrigins`
15. **M2**: Add HSTS header when TLS is active
16. **M3**: Store SHA-256 hash of refresh tokens instead of plaintext
17. **M6**: Check `email_confirmed_at` in password grant when verification required
18. **M13**: Enable RLS on `refresh_tokens`, `email_tokens`, `oauth_sessions`

### Phase 3 — Hardening

19. Remaining Medium and Low findings
20. Dependency updates (gomail replacement, Docker image pinning)
21. Security regression test suite for all fixed findings
