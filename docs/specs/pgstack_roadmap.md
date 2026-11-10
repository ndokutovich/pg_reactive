# pgStack Project Roadmap

**Last Updated:** 2026-11-09
**Status:** Phase 3 (GA Preparation) complete — public release pending

---

## Vision

**PostgreSQL is the application server.** Two processes (PostgreSQL + proxy), one `docker compose up`. Replace Supabase's 15+ containers with a radically simpler stack that leverages PostgreSQL's native capabilities for authentication, authorization, real-time data, storage, and business logic.

Every feature is a SQL function, an extension, or a row-level security policy. The proxy is a thin HTTP/WebSocket translator. There is no application server state -- PostgreSQL is the single source of truth.

---

## Phase 1 -- pg_reactive Standalone (COMPLETE)

**Goal:** Prove that SQL-level live queries work inside PostgreSQL as a C extension.

**Deliverables:**

- C extension (`ext/src/`) with EXCEPT-based delta computation
- Shared memory dependency tracking with LWLocks and ShmemInitHash
- Column-level tracking (uint64 bitmasks, per-query UPDATE triggers)
- LRU eviction for bounded memory usage
- Batch invalidation (per-transaction dirty set, single recompute at PRE_COMMIT)
- DDL auto-unsubscribe (ProcessUtility hook for TRUNCATE/ALTER/DROP)
- Sequence numbers in NOTIFY for gap detection
- Configurable NOTIFY channel GUC
- Rust WebSocket proxy (reference implementation; modular axum + sqlx)
- TypeScript SDK with LiveQuery class, local snapshot management, React hook
- 12 example dashboards demonstrating various query types
- pg_regress tests (17 SQL test files)
- Isolation tests (4 concurrency specs)
- Integration and E2E test suites
- Performance benchmarks (P1-P7)

**Key Metrics:**

| Metric | Result |
|--------|--------|
| Write throughput (1 sub) | ~222 TPS |
| Write throughput (10 subs) | ~99 TPS |
| E2E latency | 3 ms p50 |
| Fan-out (200 clients) | 0 misses |

---

## Phase 2 -- pgStack MVP (COMPLETE)

**Goal:** Transform pg_reactive from a standalone extension into a full backend platform comparable to Supabase.

### Authentication (auth/)

| Feature | Status |
|---------|--------|
| Email/password signup and login | Done |
| JWT access tokens (HS256, configurable expiry) | Done |
| Refresh tokens with family-based reuse detection | Done |
| OAuth (Google, GitHub) with PKCE (S256) | Done |
| Magic links (passwordless login) | Done |
| Email verification | Done |
| Password reset (recovery flow) | Done |
| Admin CRUD (list, create, delete users) | Done |
| Rate limiting (30 req/min per IP on auth endpoints) | Done |
| SMTP mailer integration (lettre) | Done |

### REST API (rest/)

| Feature | Status |
|---------|--------|
| PostgREST-compatible CRUD (GET, POST, PATCH, DELETE) | Done |
| Filter operators (eq, neq, gt, gte, lt, lte, like, ilike, in, is) | Done |
| Ordering, pagination (limit, offset) | Done |
| Foreign key embedding (select with nested resources) | Done |
| RPC (call PostgreSQL functions via POST/GET) | Done |
| Row-Level Security enforcement (SET LOCAL ROLE) | Done |
| Catalog introspection at startup | Done |
| OpenAPI auto-generation | Done |
| Scalar vs set-returning function handling | Done |
| Count modes (exact, planned, estimated) | Done |

### Realtime (realtime/)

| Feature | Status |
|---------|--------|
| WebSocket live query subscriptions | Done |
| PG LISTEN loop with reconnect and backoff | Done |
| Broadcast channel (fan-out to N clients) | Done |
| Semaphore-based connection limiting (default 10K) | Done |
| JWT authentication on WebSocket upgrade | Done |
| General-purpose RealtimeChannel (pub/sub) | Done |

### Storage (storage/)

| Feature | Status |
|---------|--------|
| Bucket management (create, list, delete) | Done |
| File upload (multipart/form-data) | Done |
| File download | Done |
| File listing with prefix filter | Done |
| File deletion | Done |
| bytea-based storage (in PostgreSQL) | Done |
| Bucket ACLs | Done |

### SDK (@pgstack/sdk)

| Feature | Status |
|---------|--------|
| PgStackClient with auth-aware headers | Done |
| Query builder (from, select, eq, order, limit, etc.) | Done |
| Auth client (signup, login, logout, refresh, state change) | Done |
| Storage client (upload, download, list, remove) | Done |
| LiveQuery client with snapshot management | Done |
| RealtimeChannel (pub/sub) | Done |
| React hooks: useAuth, useLiveQuery, useRpc | Done |
| Server-side admin client (PgReactiveAdmin) | Done |
| DBOS job queue and scheduler | Done |

### CLI (pgstack)

| Command | Description | Status |
|---------|-------------|--------|
| `pgstack init <name>` | Scaffold new project (docker-compose, migrations, .env) | Done |
| `pgstack dev` | Start PostgreSQL + proxy in Docker | Done |
| `pgstack stop` | Stop containers | Done |
| `pgstack deploy --host <user@server>` | Deploy to production via SSH | Done |
|  `pgstack migration create <name>` | Create timestamped migration file | Done |
| `pgstack migration run` | Apply pending migrations | Done |
| `pgstack migration rollback` | Roll back last migration | Done |
| `pgstack migration status` | Show migration status | Done |
| `pgstack db shell` | Open psql shell | Done |
| `pgstack db reset` | Reset database | Done |
| `pgstack db seed` | Run seed SQL | Done |
| `pgstack db branch` / `pgstack db checkout` | Database branching (TEMPLATE clone) | Done |
| `pgstack generate types` | Generate TypeScript types from schema | Done |
| `pgstack functions new\|list\|deploy\|delete\|serve` | Edge function management | Done |
| `pgstack logs` | Tail container logs | Done |
| `pgstack dbos` | DBOS job queue management | Done |
| `pgstack status` | Show container and service status | Done |
| `pgstack studio` | Open Studio dashboard in browser | Done |

### Studio (React SPA)

| Feature | Status |
|---------|--------|
| Table editor (browse, create, edit, delete rows) | Done |
| SQL editor (execute queries, view results) | Done |
| Auth manager (list users, create, delete) | Done |
| Realtime monitor (view live query subscriptions) | Done |
| Served at /studio/ with relaxed CSP | Done |

### Infrastructure

| Item | Status |
|------|--------|
| Docusaurus 3 documentation site (37 pages, 8 sidebar categories) | Done |
| CI/CD pipelines (GitHub Actions) | Done |
| Docker images (GHCR) | Done |
| Production docker-compose with .env.example | Done |

---

## Phase 3 -- GA Preparation (COMPLETE)

**Goal:** Harden the platform for general availability. Complete testing and documentation. (Proxy parity is settled: the Go proxy is the primary implementation and exceeds the Rust reference.)

| Task | Status |
|------|--------|
| Go proxy feature parity with Rust proxy | Done — Go proxy is primary and exceeds it (edge functions, batch endpoint, TLS autocert); Rust proxy kept at security parity |
| Advanced query type testing (recursive CTEs, lateral joins) | Done |
| Batch invalidation optimization | Done |
| OpenAPI auto-generation from catalog | Done |
| Studio Playwright E2E tests | Done |
| Updated specification documents (this document) | Done |
| Landing page and marketing site | Done — pgstack.org |
| npm package publishing preparation | Done — `@pgstack/sdk` and `pgstack` at 0.3.3, trusted publishing over OIDC |
| Docker Hub image publishing preparation | Done — four images at 0.3.3, promoted from CI by digest |
| Version inventory and freshness gate | Done — `docs/VERSIONS.md`, checked weekly in CI |

### Release surfaces

| Surface | What ships |
|---------|-----------|
| npm | `@pgstack/sdk`, `pgstack` |
| Docker Hub | `pgstack-proxy`, `pgstack-proxy-rust`, `pgstack-postgres`, `pgstack-all-in-one` |
| GHCR | The same four images, built once per commit and promoted by digest |
| GitHub Releases | One per tag, with the changelog section |

---

## Technology Stack

| Component | Technology | Approximate LOC |
|-----------|-----------|-----------------|
| C Extension | C, PostgreSQL SPI/shmem | ~3,000 |
| Go Proxy | Go, chi, pgx, zerolog | ~14,000 |
| Rust Proxy | Rust, axum, sqlx | ~3,200 |
| TypeScript SDK | TypeScript | ~2,500 |
| TypeScript CLI | TypeScript, commander | ~2,000 |
| Studio (React SPA) | React, Vite, Tailwind CSS | ~8,000 |
| Tests | SQL, TypeScript, Python, JavaScript | ~5,000 |
| Documentation | Markdown, Docusaurus 3 | ~6,000 |
| Docker / CI | YAML, Dockerfile, Shell | ~1,000 |
| **Total** | | **~44,500** |

---

## Feature Parity vs Supabase

| Feature | Supabase | pgStack | Notes |
|---------|----------|---------|-------|
| Auth (email/password) | Yes | Yes | |
| Auth (OAuth) | Yes (many providers) | Yes (Google, GitHub, Apple, Microsoft, generic OIDC) | |
| Auth (magic links) | Yes | Yes | |
| Auth (email verification) | Yes | Yes | |
| Auth (password reset) | Yes | Yes | |
| Auth (admin API) | Yes | Yes | |
| REST API | PostgREST (Haskell) | PostgREST-compatible (Go) | Same query string API |
| REST (FK embedding) | Yes | Yes | Nested embedding supported |
| REST (RPC) | Yes | Yes | Scalar + set-returning |
| Realtime | Postgres Changes (table-level) | Live Queries (query-level) | pg_reactive is more granular |
| Realtime Channels | Yes | Yes | General pub/sub |
| Storage | S3-backed (separate service) | bytea (in PostgreSQL) | Simpler, no external deps |
| Edge Functions | Deno (separate service) | Yes (5 runtimes: goja, PL/v8, PL/Python, Deno, http) | In-process, in-DB, sidecar, and per-function container options |
| Dashboard | Yes (Next.js) | Yes (React SPA) | |
| CLI | Yes | Yes | |
| TypeScript SDK | Yes | Yes (compatible API) | |
| React Hooks | Community | Built-in | useAuth, useLiveQuery, useRpc |
| Self-hosted | Yes (complex) | Yes (simple) | 2 containers vs 15+ |
| Database branching | No | Yes | `pgstack db branch` / `pgstack db checkout` (TEMPLATE clone) |
| Job queue | No (use pg_cron) | Yes (DBOS) | Built-in scheduler |
| Type generation | Yes | Yes | `pgstack generate types` |

### Architectural Differences

| Aspect | Supabase | pgStack |
|--------|----------|---------|
| Number of containers | 15+ (Kong, GoTrue, PostgREST, Realtime, Storage, Meta, Studio, etc.) | 2 (PostgreSQL + proxy) |
| API Gateway | Kong (separate process) | Built into proxy |
| Auth service | GoTrue (separate Go process) | Built into proxy |
| REST service | PostgREST (separate Haskell process) | Built into proxy |
| Realtime service | Elixir Phoenix (separate process) | pg_reactive C extension + proxy |
| Storage service | Separate Go process + S3 | bytea in PostgreSQL |
| Proxy binary size | N/A (multiple services) | ~15 MB |
| Cold start time | Minutes (15+ containers) | Seconds (2 containers) |

---

## Test Coverage Summary

| Category | Count | Technology |
|----------|-------|------------|
| pg_regress (C extension) | 17 files | SQL |
| Isolation tests | 4 specs | pg_isolation_regress |
| SDK unit tests | 92 tests | Vitest |
| CLI tests | 160 tests | Vitest |
| Studio Playwright tests | 40 tests | Playwright |
| E2E suites | 24 scripts | Node.js |
| Security regression tests | 12 scripts | Node.js |
| Integration tests | 5 scripts | Python |
| Performance tests (P1-P7) | 7 benchmarks | Python + Node.js |
| Security lint | 1 script (SEC-R* rules) | Node.js |
| Doc SQL smoke test | 1 harness | Node.js |

Every count above is what the tree contains today; the numbers are checked
against `git ls-files` rather than carried forward from an earlier phase.
Unit tests total 292 across the three suites.

---

## Timeline

```
2025-Q3    Phase 1: pg_reactive standalone       [COMPLETE]
2025-Q4    Phase 2: pgStack MVP                  [COMPLETE]
2026-Q1    Phase 3: GA Preparation               [COMPLETE]
2026-Q2    Open source release                   [PENDING]
```
