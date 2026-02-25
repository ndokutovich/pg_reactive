# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

pg_reactive is a PostgreSQL C extension that turns SQL SELECTs into live queries with real-time delta notifications. Three-layer architecture: C extension (ext/) → Rust WebSocket proxy (proxy/) → TypeScript SDK (sdk/).

## Development Environment

Everything runs in Docker. PG data is on tmpfs (ephemeral). Extension source is COPY'd into the image at build time (no bind mounts — they cause OOM on WSL2).

```bash
docker compose up -d --build        # Start PG + proxy (rebuilds if code changed)
docker compose build --no-cache db  # Force full rebuild (after Docker prune)
```

Host access: PG at `127.0.0.1:15432`, WebSocket proxy at `127.0.0.1:8080`.

## Build & Test Commands

### C Extension (runs inside container)

```bash
# Build + install
docker compose exec -T db bash -c 'cd /ext/ext && make clean && make && make install'

# pg_regress tests (7 SQL test files)
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

### E2E Tests (require running docker compose)

```bash
node tests/e2e_ws_test.mjs               # WebSocket delta delivery
node tests/e2e_fanout_test.mjs            # Multi-client fan-out
JWT_SECRET=test node tests/e2e_jwt_test.mjs  # JWT auth scenarios
```

### Integration Tests (run inside container)

```bash
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_shmem_pressure.py'
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_notify_throughput.py'
```

### Performance Tests

```bash
bash tests/perf/runner.sh    # Full suite (~10 min): P1-P6 with PASS/FAIL thresholds

# Individual container tests (Python)
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p1_write_throughput.py'
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p2_snapshot_stress.py'
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p6_cascade.py'

# Individual host tests (Node.js, require ws package)
node tests/perf/p3_e2e_latency.mjs
node tests/perf/p4_fanout_scale.mjs
node tests/perf/p5_soak.mjs
```

## Architecture

### C Extension (`ext/src/`)

All SQL functions live in the `pgr` schema (not `pg_reactive` — the `pg_` prefix is reserved).

- **pg_reactive.c** — `_PG_init()`, `ProcessUtility_hook` for DDL (TRUNCATE/ALTER/DROP), `pgr.subscribe()`, `pgr.unsubscribe()`, query parsing to extract table OIDs and column masks
- **dependency.c** — Shared memory hash table (`ShmemInitHash`) mapping query_id→table dependencies with LRU eviction. Protected by `LWLock`. Reverse index: table_oid→query_ids
- **invalidation.c** — AFTER STATEMENT triggers for INSERT/UPDATE/DELETE. Column-level tracking via `uint64` bitmasks. Auto-installs/removes triggers on subscribe/unsubscribe
- **recompute.c** — EXCEPT-based delta computation. Stores snapshots in UNLOGGED tables (`pgr._snapshot_<query_id>`). Emits JSON via `pg_notify('pgr', ...)`. Overflow at 7800 bytes
- **bgworker.c** — Optional background worker for async recompute (controlled by `pg_reactive.async_recompute` GUC, PGC_POSTMASTER)

### Rust Proxy (`proxy/src/main.rs`)

Single-file server using hyper + tokio-tungstenite. Listens on PG `NOTIFY pgr` channel, fans out to WebSocket clients via `broadcast::channel`. JWT auth (HS256) when `JWT_SECRET` env var is set. Semaphore-based connection limiting (default 10K).

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

Single channel `pgr` for all queries:
- Delta: `{"query_id":"...","inserted":[...],"deleted":[]}`
- Overflow: `{"type":"overflow","query_id":"...","fetch":true}`
- Proxy welcome: `{"type":"subscribed","query_id":"..."}`

### pg_regress Stats Tests

Use `\gset` for relative counter checks — shared memory counters accumulate across pg_regress runs since the extension loads at server start via `shared_preload_libraries`.

### Extension Control File

Do NOT set `schema =` in `pg_reactive.control` when the SQL install script creates its own schema. The extension creates `pgr` schema in the install script.

## GUC Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pg_reactive.max_subscriptions` | PGC_POSTMASTER | 1024 | Shared memory slots. Requires restart. Set via docker-compose `command:` flag |
| `pg_reactive.async_recompute` | PGC_POSTMASTER | off | Enable background worker. Requires restart |
