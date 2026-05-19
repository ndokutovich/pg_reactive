# Security Policy

## Supported Versions

This project is on pre-1.0. Security fixes land on `master` and are released in
the next tagged version. We do not yet maintain backports — please upgrade to
the latest release.

| Component        | Versioning                                        |
|------------------|---------------------------------------------------|
| C extension      | Tracked in `ext/pg_reactive.control` (`default_version`) |
| Go proxy         | Tracked by git tag on the monorepo                |
| TypeScript SDK   | `sdk/package.json` (semver, published separately) |
| CLI              | `cli/package.json` (semver, published separately) |

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security reports.

Email: **ndokutovich@gmail.com** with subject prefix `[pg_reactive security]`.

If you prefer encrypted communication, include a PGP key request in your
initial message and we will respond with a key fingerprint.

Please include:

- Affected component (`ext/`, `proxy-go/`, `sdk/`, `studio/`, `cli/`)
- Affected version or commit SHA
- A minimal reproduction (proof-of-concept code, request, or steps)
- Your assessment of impact (data exposure, RCE, auth bypass, DoS, etc.)
- Whether the issue is being actively exploited

### What to expect

- **Acknowledgement** within 72 hours.
- **Initial triage** within 7 days — confirming the issue, severity rating, and
  expected timeline.
- **Fix and disclosure** coordinated with the reporter. We aim for ≤ 30 days for
  high-severity issues and ≤ 90 days for medium/low. Critical issues may
  ship out-of-band.

We will credit reporters in release notes unless you ask to remain anonymous.

## Scope

In scope:

- The C extension (`ext/`) — SQL injection, RLS bypass, shared-memory safety,
  privilege escalation through `pgr.subscribe()` / `pgr.unsubscribe()`.
- The Go proxy (`proxy-go/`) — auth flows (JWT, OAuth, refresh tokens),
  PostgREST-compatible REST, RLS context handling, WebSocket auth and
  audience enforcement, edge function sandboxing, webhook delivery (SSRF),
  rate limiting, CORS / CSP / HSTS.
- The TypeScript SDK (`sdk/`) — token storage (sessionStorage discipline),
  XSS surface, realtime channel validation.
- The Studio UI (`studio/`) — XSS, CSRF, privilege checks.
- Infrastructure (`docker-compose.prod.yml`, deploy workflows) — secret
  handling, exposed ports, supply chain.

Out of scope:

- Issues that require physical access to the host or PostgreSQL superuser
  credentials.
- Self-XSS that requires the victim to paste malicious code into a console.
- Vulnerabilities in dependencies that are already disclosed upstream and have
  no exploitable surface in this codebase — please report those upstream.
- Best-practice deviations without a demonstrable exploit (e.g. "you should add
  HTTP header X"). Open a regular GitHub issue instead.

## Trust model

This section is the single source of truth for the project's trust
boundaries. Every code reviewer, contributor, auditor, and operator
reads this before proposing or accepting a security change. Code
grants and proxy gates derive their behaviour from the matrix below
— if a row here disagrees with what the code does, that is a bug to
file, not a deviation to debate.

### Roles

| Role | Identity source | Bypasses RLS? | Typical caller |
|------|-----------------|---------------|----------------|
| `anon` | no JWT, anon API key | no | unauthenticated browser |
| `authenticated` | valid JWT, `role=authenticated` | no | logged-in browser/mobile |
| `service_role` | `SERVICE_ROLE_KEY` bearer / `role=service_role` JWT | **yes** | server-side process only |
| `admin` (DBA) | direct PG connection as `postgres` | yes | migrations, ops, never network-reachable |

`anon` and `authenticated` are the only roles intended to be reachable
from a network client. `service_role` MUST NOT appear in any browser
bundle and SHOULD NOT be the default credential of any client SDK
constructor. `admin` is out of band — direct PG access only.

### Capability × role matrix

`ALLOW` = explicitly permitted. `DENY` = refused at the gate.
`COND` = conditional, see enforcement column. A `COND` cell that
turns out to mean "everyone always" is a bug. A row missing from
this matrix is a bug.

| Capability | anon | authenticated | service_role | Enforcement |
|------------|------|---------------|--------------|-------------|
| REST: GET `/rest/v1/{table}` | COND | COND | ALLOW | per-table GRANT + RLS policy; default-deny for `anon`/`authenticated` (`docker/init.sql` "no blanket grants" block) |
| REST: write `/rest/v1/{table}` | COND | COND | ALLOW | per-table GRANT + RLS policy |
| REST: `/rest/v1/rpc/{fn}` | COND | COND | ALLOW | explicit `GRANT EXECUTE` per function; `PUBLIC EXECUTE` revoked (`migrations/20260519120000_revoke_public_function_execute.sql`, round 28) |
| WebSocket: open `/ws/{queryId}` | COND | ALLOW | ALLOW | `REQUIRE_AUTHENTICATED_WS=true` refuses anon; audience binding scopes deltas (`proxy-go/realtime/`) |
| HTTP presence `/ws/_presence/{ch}` | COND | ALLOW | ALLOW | same audience gate; outside per-IP WS cap (round 22) |
| Storage: download from public bucket | ALLOW | ALLOW | ALLOW | bucket `public=true` |
| Storage: download from private bucket | DENY | COND | ALLOW | owner-match (`proxy-go/routes/storage.go`) |
| Storage: upload | DENY | ALLOW | ALLOW | any anon upload refused (round 13); per-key advisory lock serialises writers (round 17) |
| Storage: overwrite existing object | DENY | COND | ALLOW | same-owner check + atomic upsert (round 14) |
| Auth: signup / token / refresh | ALLOW | ALLOW | ALLOW | rate-limited per real-IP (`middleware/rate_limit.go`) |
| Auth: password reset / magiclink / verify | ALLOW | ALLOW | ALLOW | atomic token consume (F6 round 13); SMTP required in production (F5 round 26) |
| Auth: admin user CRUD | DENY | DENY | ALLOW | `requireServiceRole` empty-key guard (`auth/jwt.go` round 24) |
| Auth: full JWT validation | COND | COND | COND | empty `JWT_SECRET` fails closed in `GenerateToken`/`ValidateToken`/`requireJWT` (round 26 F1 CRITICAL) |
| Edge function: call any function | COND | ALLOW | ALLOW | invokes function with caller's RLS context |
| Edge function: HTTP runtime upstream | n/a | n/a | n/a | `validateUpstreamURL` rejects IP literals, dotted FQDNs, loopback bare names (round 21 F3) |
| `/api/sql` raw SQL endpoint | DENY | DENY | COND | `ENABLE_SQL_ENDPOINT=true` AND service_role bearer; refused outright in `PGSTACK_ENV=production` validator |
| Webhook CRUD | DENY | DENY | ALLOW | secret stored AES-256-GCM-encrypted at rest |
| `pgr.subscribe` (registration) | DENY | DENY | ALLOW | revoked from PUBLIC; app callers go through `SECURITY DEFINER` wrappers with fixed SQL (see `docs/specs/pg_reactive_spec.md` §9.4) |
| OTP `request_otp` / `verify_otp` | DENY | DENY | ALLOW | service-role-only — raw token returns from PG; round 30 grants explicit |

### Cross-cutting invariants

These are properties the whole stack maintains. They override any
per-capability rule that contradicts them.

1. **No blanket `GRANT ALL ... TO authenticated`** on the public schema. New tables are default-deny for `authenticated`/`anon`. The bootstrap revokes the PostgreSQL default; `migrations/20260515200000_revoke_blanket_grants.sql` enforces it on existing deployments (round 12 F3).
2. **No `PUBLIC EXECUTE` on `public.*` functions.** Functions are default-deny; expose to RPC by explicit `GRANT EXECUTE TO {role}`. Owner-loop applies the rule across `postgres` + `current_user` so multi-tenant function owners are covered (round 28 F1 + round 29 F1).
3. **`SECURITY DEFINER` requires pinned `search_path = pg_catalog, pg_temp`** plus fully-qualified object refs. Any docs/examples that violate this are bugs.
4. **`X-Forwarded-For` / `X-Forwarded-Proto` are only honoured from `TRUSTED_PROXIES`.** Without that env, the proxy uses kernel-attested `RemoteAddr` and ignores all forwarded headers. The XFF chain is walked right-to-left, skipping trusted-proxy hops, so the nginx `$proxy_add_x_forwarded_for` append pattern cannot be spoofed (round 22 F1). `X-Real-IP` is never honoured (round 23 F1).
5. **`chiMiddleware.RealIP` is NEVER added to the router.** It rewrites `RemoteAddr` from spoofable headers and defeats every gate downstream. `proxy-go/middleware/composition_test.go` "negative pin" test guards this (round 25 HIGH).
6. **Empty `JWT_SECRET` ⇒ all auth refused, not bypassed.** `GenerateToken`/`ValidateToken`/`requireJWT` are fail-closed (round 26 F1 CRITICAL).
7. **Empty `SERVICE_ROLE_KEY` ⇒ no admin requests succeed.** Round 24 empty-key guard.
8. **Raw OTP tokens never leave Postgres on any code path reachable from a non-`service_role` caller.** Round 30 HIGH.
9. **Edge function HTTP upstreams reject loopback bare hostnames** (`localhost`, `ip6-localhost`, …) in addition to IP literals (round 21 F3).
10. **HSTS `preload` is opt-in via `HSTS_PRELOAD=true`.** The `preload` directive is irreversible; never default-on (round 21 F5).
11. **JWT MUST carry a non-empty `sub` claim** to authenticate as anything other than anon — both the `/auth/v1/*` path (`auth/jwt.go:ValidateToken`) and the REST / RPC / storage path (`middleware/rls.go:validateJWT`) enforce this. Without the gate a signed-but-identityless token resolves as `authenticated` with `sub=""`, and RLS policies keyed on `auth.uid()` see NULL — any policy whose USING expression evaluates that to truthy becomes a row-level bypass (round 33 / audit F1).

## Ritual: every security finding leaves three things behind

After every audit round, CVE, or pentest finding, the fix PR MUST
also add:

1. **One negative regression test** in `tests/security/` (or the
   relevant `*_test.go` next to the code) that fails on the
   pre-fix code and passes after. No more "we caught it once and
   hope we never lose it".
2. **One updated row in the trust matrix above** (or one new row,
   or one new cross-cutting invariant). If the finding has no row
   to update, you are documenting a gap — that itself is the work.
3. **(when the class allows it) One new lint rule** in
   `tests/lint/`. If the mistake can be matched by grep or AST,
   codify it. Examples already there: `SECURITY DEFINER` without
   pinned `search_path`, `GRANT EXECUTE ... TO authenticated` next
   to a `RETURNS TEXT` raw-token function.

The pull request template (`.github/PULL_REQUEST_TEMPLATE.md`) has
the checklist. Reviewers refuse security-tagged PRs that skip it.

This ritual is what turns audit rounds from "find / fix / forget"
into cumulative hardening. Round N+1 should run against rails N
built.

## Audit history

See [`docs/SECURITY_AUDIT_2026-03-07.md`](docs/SECURITY_AUDIT_2026-03-07.md)
for the original static-analysis audit. Subsequent rounds are
referenced inline in this file's cross-cutting invariants by their
round number — that's the canonical pointer.

### Required production configuration

The proxy will refuse to start in `PGSTACK_ENV=production` mode without:

- Real secrets (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
  `POSTGRES_PASSWORD`, `SECRETS_ENCRYPTION_KEY`) — minimum 32 bytes each.
  Generate via `openssl rand -base64 32`.
- `SECRETS_ENCRYPTION_KEY` set if you intend to use edge function environment
  variables or webhook signing secrets — both are stored AES-256-GCM-encrypted
  at rest.
- `ENABLE_SQL_ENDPOINT=true` is gated to require `service_role` keys even when
  enabled. Leave it `false` unless you have a clear need.
- `ALLOW_PERMISSIVE_CORS=false` (default in production).
- `TRUSTED_PROXIES` configured if you sit behind a reverse proxy; otherwise
  `X-Forwarded-For` is ignored to prevent rate-limit bypass.

See `examples/docker-compose.prod.yml` for the canonical production overlay.
