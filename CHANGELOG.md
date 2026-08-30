# Changelog

All notable changes to pg_reactive / pgStack are tracked here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
semantic versioning per component (the PostgreSQL extension version is
declared in `ext/pg_reactive.control`).

## [Unreleased]

### Added
- All-in-one image: `/app/services.d/*.sh` sidecar hook in
  `docker/all-in-one-entrypoint.sh`. Executable scripts there are started
  after the proxy answers `/health`, log to `/var/log/pgstack/<name>.log`,
  and receive SIGTERM on shutdown (sidecars → proxy → PostgreSQL). A sidecar
  exiting never stops the container. First consumer: the Stardust game's
  multiplayer netcode (`docs/plans/stardust-on-pgstack.md`).

### Fixed
- REST upsert is now honored: `POST /rest/v1/{table}` with
  `Prefer: resolution=merge-duplicates` (or `ignore-duplicates`) and an
  optional `?on_conflict=col,col` renders `ON CONFLICT (…) DO UPDATE SET
  col = EXCLUDED.col, …` (or `DO NOTHING`); `on_conflict` defaults to the
  table's primary key. The SDK's `upsert()` has sent these since 0.2.x but
  the Go proxy ignored them and ran a plain INSERT — the second save of the
  same row died with 23505 → 409 "duplicate value violates unique
  constraint" (found by Stardust's cloud saves). Batch operations still run
  plain inserts. Contract tests in `rest/upsert_test.go`.
- All-in-one entrypoint: `docker stop` now shuts PostgreSQL down cleanly
  (exit 0 in ~10s, no WAL replay on the next start). `cmd | tee … &` put
  tee's PID in `$!`, so the SIGTERM handler signalled tee while
  postgres/proxy never got the signal — every stop ended in Docker's
  grace-period SIGKILL (exit 137). Both processes now log via `> >(tee …)`
  so `$!` is the real PID, and the handler stops sidecars → proxy →
  PostgreSQL in order with a bounded wait each (`wait_bounded`, SIGKILL as
  the fallback). Deployments should set `stop_grace_period: 30s`.
  **Known, not fixed here:** the Go proxy itself never exits after logging
  `shutdown complete` — `defer pool.Close()` waits for every connection
  while `realtime.ListenLoop` holds its LISTEN connection forever — so the
  entrypoint SIGKILLs it after `SHUTDOWN_TIMEOUT + 2s`. Harmless for data
  (PostgreSQL still stops cleanly afterwards); the proxy-side fix is to
  cancel the listen loop before the pools close.
- Example app and lesson `setup.sql` scripts are re-seed-safe: they DROP and
  recreate their tables instead of `CREATE TABLE IF NOT EXISTS`, so schema
  drift on a persistent production database can no longer survive a
  re-deploy (root cause of the "todo demo auth failed" incident).

### Changed
- CI resilience: the buildx builder persists across runs so Dockerfile cache
  mounts survive, and proxy images use npm / Go module + build cache mounts.
- `PUBLIC_DIR` static cache policy: every `.html` and any unhashed
  `.js`/`.mjs`/`.css` now gets `Cache-Control: no-cache` (revalidate every
  load) instead of `max-age=3600`. No-bundler apps serve code by its real
  filename, and the 1h TTL left players on stale code for an hour after a
  deploy. Hashed filenames keep the 1-year immutable policy; images, audio,
  fonts, wasm and json keep 1h.

## [0.2.3] — 2026-06-26

### Added
- **The Rust proxy reaches parity with the Go reference** across all three
  surfaces:
  - *Core/server API*: transaction batching, webhooks (secretbox at-rest
    encryption + the SSRF guard), storage (buckets/objects, disk + db
    backends), edge functions (Deno reverse-proxy, `http` upstream with the
    SSRF guard, PL/v8 / PL/Python routing, embedded **boa** JS runtime).
  - *Release/product*: `/docs` + the bundled Docusaurus site, `PUBLIC_DIR`
    static hosting with SPA fallback, OpenAPI on `/rest/v1`, the full OAuth
    provider set (Google/GitHub/Apple/Microsoft/OIDC, Apple `form_post`
    callback, id_token JWKS verification), TLS serving
    (`TLS_MODE` off/manual/auto via `rustls-acme`).
  - *Ops/drop-in*: HSTS on direct TLS, `READ/WRITE/IDLE/SHUTDOWN_TIMEOUT`,
    `PG_POOL_*`, `GZIP_LEVEL`, `HSTS_MAX_AGE_SECONDS`, `ALLOW_INSECURE_SMTP`.

  Two documented deltas remain: the embedded edge-function JS engine is boa
  (not goja — ~90% ES coverage, no `fetch` shim, no wall-clock interrupt),
  and auto-TLS uses TLS-ALPN-01 on :443 (not HTTP-01 on :80).

### Fixed
- Storage uploads are served with `X-Content-Type-Options: nosniff` and a
  CSP sandbox, closing stored XSS via uploaded HTML (round 46).
- Batch template substitution JSON-escapes substituted values
  (round 45 F1, invariant 27).
- OAuth sign-in enforces the provider's `email_verified` claim and refuses
  the unverified-account takeover path.
- Rust JWT validation leeway zeroed to match Go's strict expiry check.
- `pgx/v5` bumped 5.7.1 → 5.9.2 (GO-2026-5004).

## [0.2.2] — 2026-06-25

### Fixed
- Five honesty gaps between documentation and shipped behavior:
  `NOTIFY_CHANNEL` wiring, LRU-eviction warning visibility, the Rust proxy's
  framing in docs, all-in-one quickstart accuracy, and performance-claims
  positioning. Published images rebuilt.

## [0.2.1] — 2026-06-25

### Added
- Live example pages served on the pgstack.org apex: landing, the 12
  pedagogical lessons, and the demo apps — same-origin with the API.
- CLI + SDK dogfood e2e in CI: `pgstack init` → compile → live delta,
  run against the published all-in-one image.
- `docs/LINKS.md` (index of every live URL and published artifact) and
  `docs/DEPLOYMENTS.md` (map of published artifacts + live environments).

### Fixed
- **pg_reactive**: batch recompute runs as the pgr extension owner, not the
  session user.
- The all-in-one image bakes `shared_preload_libraries=pg_reactive`
  (fresh containers previously booted without the extension loaded).
- `PublicSPA` serves subdirectory `index.html`; the public CSP admits the
  example pages' inline scripts and `cdn.jsdelivr.net`.

## [0.2.0] — 2026-06-22

First published release: npm, Docker Hub/GHCR, GitHub Releases.

### Added — publishing
- npm packages `@pgstack/sdk` (client SDK) and `pgstack` (CLI).
- Four Docker images — `pgstack-proxy` (Go), `pgstack-proxy-rust` (R52),
  `pgstack-postgres` (PG16 + extension), `pgstack-all-in-one` quickstart
  (R54). CI builds and smoke-tests on GHCR; the release workflow promotes
  the **exact smoked digest** and mirrors it to Docker Hub `pgstack/*`
  (R53, no rebuild).
- VPS deploy workflow (SSH), gated on CI.

### Added — extension 0.1.3 → 0.1.8
- **0.1.3**: security-only default-deny upgrade — `REVOKE EXECUTE` on
  `pgr.get_subscriptions()`/`pgr.stats()`, `REVOKE SELECT` on
  `pgr.subscriptions` from PUBLIC (audit finding L8).
- **0.1.4**: durable subscription persistence — `pgr.persisted_subscriptions`
  catalog + `pgr.restore_subscriptions()` rebuild shmem state after restart
  (SQL API signatures unchanged).
- **0.1.5**: `pgr.subscription_meta(query_id)` — the transactional
  audience/mode source the WebSocket proxy gate reads (round 37 F1).
- **0.1.6**: generation-based revocation of stale WebSocket connections —
  every subscribe/unsubscribe bumps a monotonic generation stamped into
  every NOTIFY payload; the proxy delivers only on exact generation match
  and disconnects stale connections on `resubscribed` (round 39).
- **0.1.7/0.1.8**: `pgr.restore_subscriptions()` privilege-escalation fix —
  replay runs `SECURITY INVOKER` with per-row `SET LOCAL ROLE` to the
  captured subscriber, never as superuser (Gemini audit P1, both rounds).

### Added — security
- The proxy connects as a non-superuser `authenticator` LOGIN role
  (NOINHERIT + `SET ROLE`): data pool under RLS, admin pool as
  `service_role`; `verifyPoolRoles` fail-closed startup check across six
  dimensions (invariant 22).
- Audience-bound subscriptions (finding F1 deep fix).
- Anonymous sign-in (`POST /auth/v1/anonymous`) with its own rate-limit
  bucket.
- Email verification enforced end-to-end (no auto-confirmed default);
  password reset/update revokes all refresh sessions.
- Rust proxy security-parity phases 1–3: two-pool model, token hashing,
  production validator, generation-gated WebSocket isolation.

### Added — product
- Polyglot showcase: one reference engine ported to Go, Node, FastAPI,
  Rust, .NET, and Spring, with a live dashboard.
- The 12 pedagogical example lessons (guest-JWT discipline) and the
  "What to Buy" shopping PWA.
- pgstack.org landing served from the proxy (`PUBLIC_DIR`).
- Dual licensing: `ext/` under the PostgreSQL License, everything else
  under Apache 2.0. New `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, and
  this `CHANGELOG.md`.

### Changed
- `LICENSE` in the repo root is now Apache 2.0; the PostgreSQL License
  moved to `ext/LICENSE`.
- Landing variants no longer ship copy-pasteable dev secrets; they show
  `--env-file .env` and instruct generating secrets with
  `openssl rand -base64 32`.

### Fixed
- SDK property tests no longer flake in the full vitest suite (removed
  unnecessary `setTimeout(5)` waits, defensive `vi.useRealTimers()`).
- Security audit document updated (M3/M14 resolved); webhooks plan brought
  in line with the implemented schema and fail-closed refresh posture.

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

[Unreleased]: https://github.com/ndokutovich/pg_reactive/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/ndokutovich/pg_reactive/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ndokutovich/pg_reactive/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ndokutovich/pg_reactive/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ndokutovich/pg_reactive/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ndokutovich/pg_reactive/releases/tag/v0.1.1
