# pg_reactive

**Live queries for PostgreSQL.** Subscribe to any `SELECT` from inside the
database, get a `NOTIFY` payload with exact insert/delete row deltas whenever
the result set changes. ~3 ms commit-to-NOTIFY on the dev box, column-level
invalidation tracking so unrelated UPDATEs don't wake your subscribers.

A C extension. No background services, no logical replication slot, no
external coordinator. Just `CREATE EXTENSION pg_reactive` and a `pgr.subscribe()`
call.

> This is the standalone extension. If you want a full backend stack
> (Auth, REST, WebSocket fan-out, Studio, SDK, edge functions) built on
> top of `pg_reactive`, see the umbrella project — [pgStack](../README.md).

## Install

### From source

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive/ext
make
sudo make install
```

Then in your `postgresql.conf`:

```ini
shared_preload_libraries = 'pg_reactive'
pg_reactive.max_subscriptions = 1024     # shared memory slots
```

Restart PostgreSQL and run:

```sql
CREATE EXTENSION pg_reactive;
```

### Requires

- PostgreSQL 16 or newer
- `pg_config` on `$PATH` (PGXS-based build)
- A C toolchain (gcc/clang, make)

## Use

```sql
-- Subscribe to a query under a stable id.
SELECT pgr.subscribe('orders_active', $$
    SELECT id, customer_id, total, status
    FROM orders
    WHERE status IN ('open', 'pending')
$$);

-- Anything that listens on the 'pgr' NOTIFY channel will receive a JSON
-- delta whenever this query's result set changes.
LISTEN pgr;

-- Inserts, updates, deletes that affect the query trigger a delta:
INSERT INTO orders (customer_id, total, status) VALUES (42, 99.99, 'open');
-- → NOTIFY pgr, '{"query_id":"orders_active","inserted":[{"id":7,"customer_id":42,"total":99.99,"status":"open"}],"deleted":[]}'

-- Unsubscribe when done.
SELECT pgr.unsubscribe('orders_active');
```

That's the whole interface. Any client capable of `LISTEN pgr` (psql,
pgx, libpq, JDBC, asyncpg, the `pg` Node driver, …) can drive a live UI
off this stream.

## SQL API

All functions live in the `pgr` schema (not `pg_reactive` — the `pg_`
prefix is reserved by PostgreSQL for system schemas).

| Function | Description |
|----------|-------------|
| `pgr.subscribe(query_id text, query text) → void` | Register a live query under `query_id`. Validates the query is a pure `SELECT` (no DML CTEs). |
| `pgr.unsubscribe(query_id text) → void` | Remove a subscription and its snapshot table. |
| `pgr.get_subscriptions() → setof record` | List active subscriptions. |
| `pgr.stats() → record` | Counters: deltas emitted, recomputes, evictions, overflow events. |

## Wire format (NOTIFY channel `pgr`)

All payloads are JSON. Single channel for all subscriptions.

```json
{"query_id":"orders_active","inserted":[{"id":7,...}],"deleted":[{"id":3,...}]}
{"type":"overflow","query_id":"orders_active","fetch":true}
```

- **Delta** — `inserted` and `deleted` arrays contain only the rows that
  changed. Updates appear as a paired `deleted` + `inserted` for the
  same primary-key row.
- **Overflow** — the payload would exceed PostgreSQL's 8 KB `NOTIFY`
  limit. Receiver should re-fetch the full query result. Triggered at
  7800 bytes.

## How it works

1. `pgr.subscribe()` parses your query, extracts the table OIDs it
   depends on, computes a column mask per table, and stores the
   dependency in shared memory under an `LWLock`-protected hash with
   LRU eviction.
2. It installs per-query `AFTER STATEMENT` triggers on the depended-on
   tables for INSERT, UPDATE, DELETE. Update triggers carry the
   column mask so unrelated column changes are skipped without doing
   any work.
3. A `ProcessUtility_hook` watches for `TRUNCATE`, `ALTER`, and `DROP`
   on subscribed tables and auto-unsubscribes / re-snapshots as needed.
4. When a trigger fires, it computes the delta via `EXCEPT` against an
   `UNLOGGED` snapshot table (`pgr._snapshot_<query_id>`), updates the
   snapshot, and emits the delta via `pg_notify('pgr', ...)`.

### Performance baselines

Measured on Docker Desktop on Windows (WSL2 backend), 2026-02 with the
temp-table recompute optimization:

| Scenario                          | Throughput | Latency (p50) |
|-----------------------------------|-----------:|--------------:|
| 1 subscription, mixed DML         |  ~222 TPS  |        4.4 ms |
| 10 subscriptions, mixed DML       |   ~99 TPS  |        9 ms   |
| EXCEPT on 1K-row snapshot         |       —    |        2.8 ms |
| EXCEPT on 10K-row snapshot        |       —    |       18.5 ms |
| EXCEPT on 100K-row snapshot       |       —    |      263 ms   |
| Commit-to-NOTIFY end-to-end       |       —    |        3 ms   |
| 200-client WebSocket fan-out      |   0 missed |             — |

Your numbers will depend on snapshot size, DML mix, and how aggressively
your queries can be column-masked.

## Configuration (postgresql.conf)

| Parameter | Default | Restart? | Description |
|-----------|--------:|----------|-------------|
| `shared_preload_libraries` | — | yes | Must include `pg_reactive`. |
| `pg_reactive.max_subscriptions` | `1024` | yes | Shared memory subscription slot count. |
| `pg_reactive.async_recompute` | `off` | yes | Background worker for async recompute. Off is fine for most workloads. |

Both `pg_reactive.*` GUCs are `PGC_POSTMASTER` — they require a server
restart to change.

## Testing

`pg_regress` suite (10 SQL files) covers subscribe/unsubscribe semantics,
column-level invalidation, GROUP BY / window / HAVING / LEFT JOIN queries,
cross-table dependencies, overflow handling, DDL auto-unsubscribe, and
batch invalidation:

```bash
cd ext
make installcheck
```

Isolation specs (3 files) cover concurrent DML, concurrent subscribe,
and concurrent invalidation:

```bash
cd ext
make isolation_installcheck
```

If a regress test fails, the diff lands in `regression.diffs` and the
actual output in `results/`. Trailing whitespace in expected output is
significant — copy from `results/` when updating.

## Project structure

```
ext/
  src/
    pg_reactive.c     _PG_init, ProcessUtility_hook for DDL, subscribe/unsubscribe
    dependency.c      Shared-memory hash (query_id → tables) with LRU eviction
    invalidation.c    AFTER STATEMENT triggers, column-mask tracking, auto-installation
    recompute.c       EXCEPT-based delta computation, snapshot tables, NOTIFY emission
    bgworker.c        Optional background worker (pg_reactive.async_recompute)
  pg_reactive--0.1.sql        Install script (creates `pgr` schema)
  pg_reactive--0.1.0--0.1.1.sql, 0.1.1--0.1.2.sql   Migrations
  pg_reactive.control          Extension metadata
  Makefile                     PGXS build
  sql/                         pg_regress tests
  expected/                    Expected test output
  specs/                       Isolation test specs
```

## License

PostgreSQL License — see [`LICENSE`](LICENSE). The same license under
which PostgreSQL itself is distributed.

## Project home

The extension is developed inside the [pg_reactive / pgStack](https://github.com/ndokutovich/pg_reactive)
monorepo. Issues and PRs specific to the extension are welcome there —
prefix the title with `ext:` so they're easy to triage.

- Security reports: see [`../SECURITY.md`](../SECURITY.md).
- Contributing: see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- Changelog: see [`../CHANGELOG.md`](../CHANGELOG.md) (entries marked
  with extension-version tags).
