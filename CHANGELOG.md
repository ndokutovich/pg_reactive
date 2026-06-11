# Changelog

All notable changes to pg_reactive / pgStack are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
semantic versioning per component (the PostgreSQL extension version is
declared in `ext/pg_reactive.control`).

## [Unreleased]

### Added
- **pg_reactive 0.1.3** (`ext/pg_reactive--0.1.2--0.1.3.sql`): security-only
  upgrade — `REVOKE EXECUTE` on `pgr.get_subscriptions()` and `pgr.stats()`,
  `REVOKE SELECT` on `pgr.subscriptions` from PUBLIC, giving pre-0.1.2
  installs the same default-deny posture (audit finding L8).
- **pg_reactive 0.1.4** (`ext/pg_reactive--0.1.3--0.1.4.sql`): durable
  subscription persistence — new `pgr.persisted_subscriptions` catalog and
  `pgr.restore_subscriptions()` to rebuild shmem state after restart;
  `pgr.subscribe`/`pgr.unsubscribe` re-shaped as plpgsql wrappers over new
  `pgr._subscribe_internal`/`pgr._unsubscribe_internal` C entry points
  (SQL API signatures unchanged).
- Dual licensing scheme: `ext/` under PostgreSQL License, everything else
  under Apache License 2.0. New `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`,
  and this `CHANGELOG.md`.

### Changed
- `LICENSE` in repo root is now Apache 2.0. The PostgreSQL License was moved
  to `ext/LICENSE` to make the extension layer's licensing explicit.

### Fixed
- SDK property tests no longer flake when run as part of the full vitest
  suite — removed `setTimeout(5)` waits that were unnecessary (the SDK wires
  WebSocket `onmessage` synchronously) and added defensive
  `vi.useRealTimers()` cleanup in both `index.test.ts` and
  `index.property.test.ts`.
- Security audit document (`docs/SECURITY_AUDIT_2026-03-07.md`) updated to
  reflect that M3 (refresh tokens) and M14 (edge function env vars) are
  resolved. Broken link to a non-existent `SECURITY.md` removed.
- Landing variants under `docs/pgstack-landing/` no longer ship
  copy-pasteable dev secrets (`POSTGRES_PASSWORD=secret`, `JWT_SECRET=...`).
  They now show `--env-file .env` and instruct readers to generate secrets
  with `openssl rand -base64 32`.
- Webhooks plan (`docs/plans/fluttering-mapping-teapot.md`) brought in line
  with the implemented `secret_encrypted BYTEA` schema, the fail-closed
  `Refresh()` posture, the dedicated `pgstack.webhook_notify()` trigger, and
  the SSRF-hardened HTTP client.

## [0.1.2] — 2026-05 (Security Hardening Series)

The 0.1.x line of the extension and Go proxy received eleven rounds of
adversarial review and the following security hardening lands across them.

### Added
- **Audience-bound subscriptions** (pg_reactive 0.1.2). `pgr.subscribe()`
  records an audience claim and `NOTIFY pgr` payloads include the audience
  fingerprint. The proxy refuses to deliver deltas to clients that do not
  match.
- **AES-256-GCM secret-at-rest encryption** for edge function environment
  variables (`pgstack.edge_functions.env_vars_encrypted`) and webhook
  signing secrets (`pgstack.webhooks.secret_encrypted`) under
  `SECRETS_ENCRYPTION_KEY` (`proxy-go/secrets/secretbox.go`).
- **Trigger-based webhook delivery** via dedicated `pgstack.webhook_notify()`
  function on the `pgstack_webhooks` NOTIFY channel — replaces the
  abandoned attempt to derive webhooks from the live-query delta stream.
- **SSRF guard** on webhook delivery: hardened `http.Client` with redirects
  disabled and custom `Dialer.Control` refusing loopback, private,
  link-local, multicast, CGNAT, and IANA-reserved IPs. Refresh-time URL
  validation drops unsafe URLs from the in-memory cache (fail-closed).
- **Refresh token hashing**: `pgstack.refresh_tokens.token_hash` stores
  SHA-256 of the opaque refresh token. Plaintext is never persisted.
- **`PGSTACK_ENV=production` strict validator** — refuses to start with
  default dev secrets, `ENABLE_SQL_ENDPOINT=true`,
  `ALLOW_PERMISSIVE_CORS=true`, or a missing `SECRETS_ENCRYPTION_KEY`.
- **Trusted-proxy configuration** (`TRUSTED_PROXIES`) for safe
  `X-Forwarded-For` handling. Untrusted requests fall back to
  `RemoteAddr`, preventing rate-limit bypass.
- **HSTS header** when TLS is active; `Permissions-Policy` placeholder.
- **WebSocket `Origin` validation** against `AllowedOrigins`.
- **WebSocket presence handler** behind the same auth + audience gate as
  the WS upgrade — closes the unauthenticated HTTP side channel.
- **Anti-spoofing**: WS client messages have `client_id` stripped from the
  frame; the server uses the connection-bound identity.
- **Bootstrap-env script** (`scripts/bootstrap-env.sh`) for one-shot
  idempotent secret generation on a fresh VPS.
- **Production compose overlay** (`examples/docker-compose.prod.yml`) with
  `${VAR:?required}` fail-fast on missing secrets.

### Changed
- Browser persistence in the SDK and Studio moved from `localStorage` to
  `sessionStorage` to limit XSS-stolen token lifetime.
- JWT validation rejects oversized claims rather than truncating them.
- OAuth error responses use a generic message in the redirect fragment;
  internal error details stay in server logs.
- Edge function `goja` runtime now runs SQL inside an RLS transaction
  using the caller's JWT claims (was: raw pool connection with full
  privileges).
- Batch template-resolution URL-encodes substituted values to prevent
  filter operator injection in query strings.
- C extension shared-memory accessors return data by value under lock
  (was: returning pointers that could be invalidated by concurrent
  `HASH_REMOVE`).
- `pgr.subscribe()` validates the query is a pure `SELECT` and rejects
  DML CTEs (`WITH x AS (DELETE … RETURNING *) SELECT …`).
- Constant-time comparison for service-role key (`crypto/subtle`).

### Fixed
- `int64` printf format on Windows (`%ld` → `INT64_FORMAT`).
- JSON column-name escaping in NOTIFY payloads.
- Rate limiter unbounded memory growth — background cleanup goroutine.
- Auth recover / magiclink endpoints now rate-limited.
- Body size limit on edge function invocations.
- Catalog refresh error messages no longer leak hostnames or internal
  details.
- Production port binds to `127.0.0.1` by default (was: all interfaces).

## [0.1.1] — 2026-04

### Added
- Edge functions: Deno reverse-proxy (Supabase-compatible), embedded
  goja JS runtime, PL/v8 routing, PL/Python, and `http` (per-function
  container in any language).
- Transaction batching: `POST /rest/v1/batch` with `{{op.field}}`
  templates, atomic + partial modes.
- Studio UI (React SPA at `/studio/`): table editor, SQL editor, auth
  users, database explorer, realtime channels, logs.
- DBOS-style job queue SDK.
- Docusaurus docs site under `docs/site/`.
- k6 load tests and security regression test suites (127 Rust unit
  tests at the time of writing).
- Auth gaps: email verification, password reset, magic links, admin
  user CRUD, SMTP mailer via `lettre`.
- SDK gaps: `useAuth` hook, `RealtimeChannel`, generic query builder.

### Changed
- CLI gained `pgstack status`, `pgstack studio`, migration rollback,
  migration list.

## [0.1.0] — 2026-03

### Added
- Initial release of the pg_reactive C extension: per-query AFTER
  STATEMENT triggers, column-level invalidation tracking via 64-bit
  bitmasks, EXCEPT-based delta computation, snapshots in UNLOGGED
  tables, `NOTIFY pgr` payloads, overflow signaling at 7800 bytes,
  optional background worker for async recompute.
- Initial Rust proxy (now superseded by the Go proxy below).
- TypeScript SDK with `LiveQuery` and `createClient`.
- pg_regress and isolation test suites.

[Unreleased]: https://github.com/ndokutovich/pg_reactive/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ndokutovich/pg_reactive/releases/tag/v0.1.1
