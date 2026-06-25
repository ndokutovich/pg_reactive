# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

pg_reactive is a PostgreSQL C extension that turns SQL SELECTs into live queries with real-time delta notifications. Three-layer core: C extension (ext/) → two sibling WebSocket proxies, Go (proxy-go/) and Rust (proxy/), co-equal in intent → TypeScript SDK (sdk/). **Go is the reference implementation.** The **Rust sibling is at SECURITY-invariant parity**, proven by running the full adversarial suite (`tests/security/*` + the gen-WS e2e) against the Rust proxy on :8081: verifyPoolRoles 21/21, generation-gated WS (F-ORDER/F-SNAP/TOCTOU/RevokeStale), presence gen-isolation, RLS, JWT (strict expiry), anon-signin, rate-limit + per-IP WS cap, config validator, HSTS/CSP. **FEATURE parity is now COMPLETE too** — the Rust proxy has transaction batching, webhooks (+ secretbox at-rest encryption + the SSRF guard), storage (buckets/objects, disk+db), and edge functions (deno reverse-proxy, http upstream w/ SSRF, plv8/plpython3u routing, and an embedded JS runtime on **boa** rather than Go's goja — ~90% ES coverage, no `fetch` shim, no wall-clock interrupt; documented deltas). Every feature was verified by running the Go e2e against BOTH proxies. So both proxies are co-equal in security AND feature surface; hold any change to the trust model on both. Around that core lives the pgStack umbrella: a Supabase-compatible REST/RPC/auth/storage/edge-functions layer (also in `proxy-go/`), a CLI (`cli/`) that scaffolds new pgStack projects, a Studio SPA (`studio/`), and a Docusaurus docs site (`docs/site/`).

## Security discipline — read this BEFORE touching auth / RLS / grants / secrets

[`SECURITY.md`](SECURITY.md) is the single source of truth for the project's trust boundaries. The "Trust model" section there has:

- the role list (`anon` / `authenticated` / `service_role` / `admin`),
- a capability × role matrix for every network-reachable surface, and
- 13 cross-cutting invariants (no PUBLIC EXECUTE on functions, chi.RealIP must never be added, empty JWT_SECRET fails closed, etc).

When you change anything that touches a capability in that matrix, the **ritual** applies (also documented in SECURITY.md and enforced by `.github/PULL_REQUEST_TEMPLATE.md`):

1. **One negative test** in `tests/security/` (or `*_test.go` next to the code) that fails on pre-fix and passes after. Reference the audit round / invariant number in the test header.
2. **One updated row** in the SECURITY.md trust matrix, or a new row/invariant if you're documenting a gap.
3. **One lint rule** in `tests/lint/security_patterns.mjs` when the mistake can be grep-matched (codify the class, not just the instance).

In commit messages and code comments the project refers to past fixes by **round number** (e.g. "round 26 F1 CRITICAL"). Use the same style — search `git log --grep "round NN"` to find the rationale for a hardening you're about to touch.

## Development Environment

Everything runs in Docker. PG data is on tmpfs (ephemeral). Extension source is COPY'd into the image at build time (no bind mounts — they cause OOM on WSL2).

```bash
docker compose up -d --build        # Start PG + proxy (rebuilds if code changed)
docker compose build --no-cache db  # Force full rebuild (after Docker prune)
```

Host access: PG at `127.0.0.1:15432`, WebSocket proxy at `127.0.0.1:8080`.

### All-in-one deployments

`docker/Dockerfile.all-in-one` + `docker/all-in-one-entrypoint.sh` are the
canonical "PostgreSQL + extension + proxy in one container" build. The
entrypoint is background-and-wait (proxy is lifecycle leader), forwards its
args to `postgres` (GUC flags via the compose `command:`), and runs an
optional `/app/post-init.sh` hook for deployment-specific setup. Downstream
all-in-one deployments (e.g. `roblox-clone-app`, the pgstack umbrella's
`apps/pg-reactive` and `apps/longtask-template`) `COPY` this entrypoint
rather than duplicating it — do not fork the boot logic into those repos.

## Build & Test Commands

### C Extension (runs inside container)

```bash
# Build + install
docker compose exec -T db bash -c 'cd /ext/ext && make clean && make && make install'

# pg_regress tests (12 SQL test files)
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make installcheck"'

# Isolation tests (3 concurrency specs)
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make isolation_installcheck"'

# Both together
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make installcheck && make isolation_installcheck"'

# Full rebuild + test cycle (after code changes)
docker compose restart db && sleep 10 && docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make installcheck"'
```

When pg_regress tests fail, check `ext/regression.diffs`. To update expected output, copy from `results/` inside the container (trailing whitespace matters).

### TypeScript SDK

```bash
cd sdk && npx vitest run                    # All tests
cd sdk && npx vitest run src/index.test.ts  # Single test file
cd sdk && npx tsc --noEmit                  # Type check only
```

### Rust Proxy

```bash
cd proxy && cargo check   # Type check
cd proxy && cargo build   # Build
```

The proxy is built and run via Docker in development. Direct `cargo build` is for quick compile checks only.

### Go Proxy

```bash
cd proxy-go && go build ./...             # Build all packages
cd proxy-go && go test ./...              # Run all unit tests (auth, middleware, realtime, rest, routes, functions, secrets, config/gzip/TLS)
cd proxy-go && go test -v -run TestValidate ./...  # Run specific tests
```

### CLI (`cli/`)

```bash
cd cli && npm run build    # tsc — required: bin points at cli/dist/index.js
cd cli && npm test         # vitest, 160 tests
cd cli && npx tsc --noEmit # type-check only
```

`cli/dist/` is **intentionally tracked in git** (NOT in `.gitignore` — see the comment block in the root `.gitignore`). The `bin` field in `cli/package.json` points at `dist/index.js` and npm publishes it as-is, so source/dist drift would silently ship stale (and possibly insecure) JS to anyone running `npx pgstack init`. CI has a "cli/dist parity" step that re-runs `npm run build` and fails on diff.

After editing `docker/init.sql` between the `BEGIN-PGSTACK-CORE` / `END-PGSTACK-CORE` sentinels, run:

```bash
node scripts/sync-cli-bootstrap.mjs
```

That regenerates `cli/templates/bootstrap-core.sql` (the file `pgstack init` lays into the user's first migration). CI fails on parity drift here too. See "Schema source of truth" below.

### Security / lint / adversarial fixtures

```bash
node tests/lint/security_patterns.mjs              # static lint for unsafe SQL/MD patterns
node tests/doc_sql_smoke_test.mjs                  # extract every ```sql block from docs and run it
for t in tests/security/*.test.mjs; do node "$t"; done   # negative HTTP-level regression tests
```

The lint rules are named after SECURITY.md invariants (`SEC-R3`, `SEC-R13`, `SEC-R25`, `SEC-R28`, `SEC-R30`). Override a verified-safe occurrence with `-- lint:allow=SEC-RXX` on the same line. The adversarial tests need `docker compose up` first (they hit the proxy over loopback). The doc-test harness runs each fenced `sql` block in an isolated `doctest` schema — mark intentionally-unsafe examples with `\`\`\`sql doc-test:skip=<reason>`.

### E2E Tests (require running docker compose)

```bash
node tests/e2e_ws_test.mjs               # WebSocket delta delivery
node tests/e2e_fanout_test.mjs            # Multi-client fan-out
node tests/e2e_jwt_test.mjs              # JWT auth scenarios (uses proxy default secret)
node tests/e2e_gzip_test.mjs             # Gzip compression verification
```

### Integration Tests (run inside container)

```bash
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_shmem_pressure.py'
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_notify_throughput.py'
```

### Performance Tests

```bash
bash tests/perf/runner.sh    # Full suite (~10 min): P1-P7 with PASS/FAIL thresholds

# Individual container tests (Python)
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p1_write_throughput.py'
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p2_snapshot_stress.py'
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p6_cascade.py'

# Individual host tests (Node.js, require ws package)
node tests/perf/p3_e2e_latency.mjs
node tests/perf/p4_fanout_scale.mjs
node tests/perf/p5_soak.mjs
node tests/perf/p7_concurrent_subscribe.mjs
```

## Architecture

### C Extension (`ext/src/`)

All SQL functions live in the `pgr` schema (not `pg_reactive` — the `pg_` prefix is reserved).

- **pg_reactive.c** — `_PG_init()`, `ProcessUtility_hook` for DDL (TRUNCATE/ALTER/DROP), `pgr.subscribe()`, `pgr.unsubscribe()`, query parsing to extract table OIDs and column masks
- **dependency.c** — Shared memory hash table (`ShmemInitHash`) mapping query_id→table dependencies with LRU eviction. Protected by `LWLock`. Reverse index: table_oid→query_ids
- **invalidation.c** — AFTER STATEMENT triggers for INSERT/UPDATE/DELETE. Column-level tracking via `uint64` bitmasks. Auto-installs/removes triggers on subscribe/unsubscribe
- **recompute.c** — EXCEPT-based delta computation. Stores snapshots in UNLOGGED tables (`pgr._snap_<query_id>`). Emits JSON via NOTIFY on the configurable `pg_reactive.notify_channel` channel (default `pgr`). Overflow when payload exceeds 8000 - strlen(channel) - 100 bytes (7897 for the default channel)
- **bgworker.c** — Optional background worker for async recompute (controlled by `pg_reactive.async_recompute` GUC, PGC_POSTMASTER)

### Go Proxy (`proxy-go/`)

Modular chi-based server. Listens on PG `NOTIFY pgr` channel, fans out to WebSocket clients via Hub broadcast. JWT auth (HS256) when `JWT_SECRET` env var is set. Semaphore-based connection limiting (default 10K). Includes auth endpoints, PostgREST-compatible REST API, RLS middleware, rate limiting, CORS, TLS, gzip, and edge functions across five runtimes (embedded goja JS, PL/v8, PL/Python, the global Deno sidecar, and `http` — per-function containers in any language; see `proxy-go/functions/http.go`).

### TypeScript SDK (`sdk/src/`)

- **index.ts** — `LiveQuery` class with local snapshot management, `createClient()` factory
- **react.ts** — `useLiveQuery()` React hook
- **server.ts** — `PgReactiveAdmin` class for server-side subscription management (uses `pg` driver)

## Critical Patterns

### SPI Memory Context

**Always `initStringInfo` BEFORE `SPI_connect()`**. SPI_connect switches memory context; allocations after it go into the SPI context which is destroyed by SPI_finish. Accessing those allocations after SPI_finish causes use-after-free.

### Trigger Snapshot Visibility

AFTER STATEMENT triggers can't see the triggering DML via SPI. Fix: after `SPI_connect()`, call `PopActiveSnapshot(); CommandCounterIncrement(); PushActiveSnapshot(GetTransactionSnapshot());`

### Docker Build (No Bind Mounts)

Do NOT use bind mounts for volumes on WSL2 — they cause OOM regardless of file count. Instead, files are COPY'd into the Docker image at build time (`Dockerfile.dev`). After code changes to `ext/`, rebuild with `docker compose up -d --build`.

### Git Bash Path Rewriting

Use `docker compose exec -T db bash -c '...'` with the command in quotes. Git Bash on Windows rewrites paths like `/ext` to Windows paths otherwise.

### NOTIFY Wire Format

Single channel for all queries, configurable via `pg_reactive.notify_channel` (default `pgr`). The Go proxy's data-notification channel is configurable via the `NOTIFY_CHANNEL` env var (default `pgr`, validated as a PG identifier) and must match the DB's `pg_reactive.notify_channel` for live queries to reach the proxy end-to-end. Every data payload carries `gen` — the subscription generation it was computed under; the proxy delivers a message only to connections bound to the same generation, so a re-registered subscription's data never reaches a connection authorized under the old generation (round 39 batch-2 F-ORDER):
- Delta: `{"query_id":"...","seq":N,"gen":G,"inserted":[...],"deleted":[]}`
- Overflow: `{"type":"overflow","query_id":"...","seq":N,"gen":G,"fetch":true}`
- Invalidated (mode='notify'): `{"type":"invalidated","query_id":"...","seq":N,"gen":G}`
- Resubscribed (subscribe/unsubscribe; proxy-consumed, not forwarded — drives RevokeStale): `{"type":"resubscribed","query_id":"...","gen":G}`
- Proxy welcome: `{"type":"subscribed","query_id":"..."}`

### pg_regress Stats Tests

Use `\gset` for relative counter checks — shared memory counters accumulate across pg_regress runs since the extension loads at server start via `shared_preload_libraries`.

### Extension Control File

Do NOT set `schema =` in `pg_reactive.control` when the SQL install script creates its own schema. The extension creates `pgr` schema in the install script.

### Schema source of truth (docker/init.sql ⇒ cli/templates/bootstrap-core.sql)

The security-critical bootstrap backbone — roles, schemas, auth tables, RLS, default-deny grants, function-execute revoke — lives ONCE in `docker/init.sql` between sentinel comments:

```sql
-- BEGIN-PGSTACK-CORE
... canonical security backbone ...
-- END-PGSTACK-CORE
```

`scripts/sync-cli-bootstrap.mjs` extracts that region verbatim into `cli/templates/bootstrap-core.sql`, which the CLI reads at runtime when scaffolding `pgstack init`. CI fails on drift. **Always edit `docker/init.sql` as the SoT** — never the generated template — then re-run the sync script. The same applies to security-critical SQL elsewhere: prefer adding to `init.sql` core over duplicating in CLI scaffolds, migrations, or example files.

### pgr.subscribe is a privileged API

`pgr.subscribe()` stores raw SQL that is later re-executed by `SECURITY DEFINER` triggers. Granting `EXECUTE` to an app role that also holds `CREATE FUNCTION` on any schema in its `search_path` is a definer-context RCE waiting to happen. Expose subscription registration to app clients only through purpose-built `SECURITY DEFINER` wrappers with a fixed query template, server-derived `query_id`/audience, and `SET search_path = pg_catalog, pg_temp`. See `docs/specs/pg_reactive_spec.md` §9.4 for the canonical pattern and `examples/apps/todo/setup.sql` for a working example.

### SECURITY DEFINER hardening

Every `SECURITY DEFINER` function in this repo MUST: (a) carry `SET search_path = pg_catalog, pg_temp` — no user schemas; (b) fully-qualify every object reference (`public.todos`, `pgr.subscribe`, `auth.uid`); (c) ship with an explicit `GRANT EXECUTE TO {role}` — the bootstrap default-denies `PUBLIC EXECUTE`. The `SEC-R3` lint rule catches missing pins. Without (a) a role with `CREATE` on `public` can shadow `auth.uid` and run code as the definer; without (b) the unqualified ref fails at runtime because `public` isn't on the pinned path; without (c) RPC callers see "permission denied for function".

## GUC Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pg_reactive.max_subscriptions` | PGC_POSTMASTER | 1024 | Shared memory slots. Requires restart. Set via docker-compose `command:` flag |
| `pg_reactive.async_recompute` | PGC_POSTMASTER | off | Enable background worker. Requires restart |
| `pg_reactive.database` | PGC_POSTMASTER | postgres | Database the async-recompute background worker connects to. Requires restart |
| `pg_reactive.batch_invalidation` | PGC_SUSET | on | Defer recompute to transaction pre-commit, batching multiple DML statements into one recompute per query |
| `pg_reactive.notify_channel` | PGC_SUSET | pgr | LISTEN/NOTIFY channel for all delta/overflow/invalidation notifications |
