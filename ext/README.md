# pg_reactive

**Live queries for PostgreSQL.** Register a `SELECT`; whenever its result set
changes, PostgreSQL emits a JSON delta over `NOTIFY` — the exact rows that
appeared and disappeared, nothing else.

A C extension. No background service, no logical replication slot, no external
coordinator. `CREATE EXTENSION pg_reactive`, one function call, and any client
that can `LISTEN` has a live query.

## The idea in one screen

A real session. The table is a five-column toy `orders`; the payloads are
reflowed to fit the page, everything else is verbatim.

```sql
SELECT pgr.subscribe('orders_active', $$
    SELECT id, customer_id, total, status
    FROM orders
    WHERE status IN ('open', 'pending')
$$);
```

```
                                    subscribe
----------------------------------------------------------------------------------
 {"mode": "delta", "status": "subscribed", "tables": 1, "query_id": "orders_active"}
```

```sql
LISTEN pgr;

INSERT INTO orders (customer_id, total, status, notes)
  VALUES (42, 99.99, 'open', 'first');
```

```
Asynchronous notification "pgr" with payload
  {"query_id":"orders_active","seq":1,"gen":433,
   "inserted":[{"id":1,"customer_id":42,"total":99.99,"status":"open"}],
   "deleted":[]}
```

One row appeared — and only that row crossed the wire. Now change a column the
query actually reads:

```sql
UPDATE orders SET total = 109.99 WHERE id = 1;
```

```
Asynchronous notification "pgr" with payload
  {"query_id":"orders_active","seq":2,"gen":433,
   "inserted":[{"id":1,"customer_id":42,"total":109.99,"status":"open"}],
   "deleted":[{"id":1,"customer_id":42,"total":99.99,"status":"open"}]}
```

An update is a paired delete + insert, so the client never has to diff or
guess — apply both and the snapshot is correct.

And now the part that surprises people:

```sql
UPDATE orders SET notes = 'unrelated column' WHERE id = 1;
```

```
(no notification)
```

`notes` is not in the query. `pgr.subscribe` recorded a per-column mask for
`orders`, the AFTER UPDATE trigger compared the changed columns against it, and
nothing downstream ran. No recompute, no snapshot written, no NOTIFY. On a
busy table where most writes touch columns your subscribers don't read, that is
the difference between a live query and a load generator.

## Install

From [PGXN](https://pgxn.org/dist/pg_reactive/):

```bash
pgxn install pg_reactive
```

From source:

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive/ext
make && sudo make install
```

Either way, then in `postgresql.conf`:

```ini
shared_preload_libraries = 'pg_reactive'
pg_reactive.max_subscriptions = 1024     # shared memory slots
```

Restart PostgreSQL and run:

```sql
CREATE EXTENSION pg_reactive;
```

### Requires

- PostgreSQL 15, 16, 17 or 18 — each proven in CI by the full pg_regress +
  isolation suite against a bare PGDG image (`.github/scripts/ext-pg-compat.sh`)
- `pg_config` on `$PATH` (PGXS-based build), and a C toolchain

The extension versions on its own line (0.1.8 today) — it has its own release
cadence and its own license, independent of the pgStack platform that embeds it.

## SQL API

Everything lives in the `pgr` schema — not `pg_reactive`, because PostgreSQL
reserves the `pg_` prefix for system schemas.

Every function and the `pgr.subscriptions` view are `REVOKE`d from `PUBLIC` by
default. Grant `EXECUTE` (and `SELECT` on the view) explicitly to the roles
that should manage or inspect subscriptions.

| Function | Description |
|----------|-------------|
| `pgr.subscribe(p_query_id text, p_query text, p_mode text DEFAULT 'delta', p_audience jsonb DEFAULT NULL) → jsonb` | Register a live query under `p_query_id`. Validates that the query is a pure `SELECT` (DML CTEs are rejected). `mode`: `'delta'` (full diff with snapshots) or `'notify'` (lightweight invalidation only). Persists to `pgr.persisted_subscriptions` for restart recovery. |
| `pgr.unsubscribe(p_query_id text) → boolean` | Remove a subscription, its snapshot table, its per-query triggers and its persisted row. Returns `false` if it did not exist — a safe no-op. |
| `pgr.get_subscriptions() → setof record` | Active subscriptions: `query_id`, `query_text`, `num_tables`, `subscribed_at`, `invalidation_count`, `mode`, `audience`. |
| `pgr.stats() → setof (metric text, value text)` | Counters: `active_subscriptions`, `max_subscriptions`, `total_subscribes`, `total_unsubscribes`, `total_invalidations`, `total_evictions`, `total_recomputes`. |
| `pgr.restore_subscriptions() → int` | Rebuild the in-memory hash from `pgr.persisted_subscriptions` after a restart. Idempotent; per-query failures become WARNINGs. Returns the count restored. |

Shared memory is wiped on every server restart. Run
`SELECT pgr.restore_subscriptions();` once per database afterwards — until
then, subscribed queries emit no deltas. `pgr.subscriptions` reads the live
in-memory state; `pgr.persisted_subscriptions` is the durable catalog.

`pgr.subscribe` is a privileged API: it stores SQL that `SECURITY DEFINER`
triggers later re-execute. Do not expose it to roles that also have `CREATE` on
a schema in their `search_path` — see the hardening notes in the umbrella
repository's `CLAUDE.md` for the wrapper pattern.

## Wire format

One channel for every subscription (`pg_reactive.notify_channel`, default
`pgr`). All payloads are JSON.

```json
{"query_id":"orders_active","seq":12,"gen":433,"inserted":[{"id":7,...}],"deleted":[{"id":3,...}]}
{"type":"overflow","query_id":"orders_active","seq":13,"gen":433,"fetch":true}
{"type":"invalidated","query_id":"orders_active","seq":4,"gen":433}
{"type":"resubscribed","query_id":"orders_active","gen":434}
```

- **Delta** — `inserted` and `deleted` hold only the rows that changed. An
  update appears as the same primary key in both arrays.
- **Overflow** — the payload would exceed PostgreSQL's 8 KB `NOTIFY` limit.
  The receiver should re-fetch the full result. Emitted when the payload passes
  8000 minus the channel-name length minus 100 bytes of framing (7897 bytes for
  the default channel), and also when the snapshot's column layout drifts from
  the live query (count or type change under a stable `query_id`).
- **Invalidated** — sent instead of a delta for `mode='notify'` subscriptions:
  the result *may* have changed, no query was executed. The client re-fetches
  on its own schedule.
- **Resubscribed** — a control message emitted on subscribe and unsubscribe.
  Consumed by proxies; not meant for application code.
- **`seq`** — monotonically increasing per query. A gap means a missed
  notification: re-fetch.
- **`gen`** — the subscription generation. Every payload carries it, and a
  proxy must deliver a message only to connections bound to the same
  generation, so a re-registered subscription's data never reaches a connection
  authorized under the old one.

## How it works

1. `pgr.subscribe()` parses the query, extracts the table OIDs it depends on,
   computes a column mask per table, and stores the dependency in a
   shared-memory hash under an `LWLock` with LRU eviction.
2. It installs per-query `AFTER STATEMENT` triggers for INSERT, UPDATE and
   DELETE on those tables. Update triggers carry the column mask.
3. A `ProcessUtility_hook` watches `TRUNCATE`, `ALTER` and `DROP` on subscribed
   tables and auto-unsubscribes or re-snapshots.
4. When a trigger fires, the delta is computed with `EXCEPT` against an
   `UNLOGGED` snapshot table (`pgr._snap_<query_id>`), the snapshot is updated,
   and the delta goes out via `pg_notify`.

## When it is the wrong tool

Worth knowing before you build on it:

- **Wide result sets.** The delta is computed by diffing the whole result
  against the snapshot. A 100K-row query costs ~263 ms per change. Subscribe to
  the rows a screen actually needs, not to `SELECT * FROM events`.
- **Payloads over ~7.9 KB** degrade to `overflow` + a full re-fetch. If your
  rows are large or a single statement changes thousands of them, you are
  paying for a full query anyway — use `mode='notify'` and re-fetch
  deliberately.
- **Every subscription holds a snapshot table.** `UNLOGGED`, but it is real
  disk and real write amplification. `max_subscriptions` caps the count; the LRU
  evicts beyond it.
- **Single node.** LISTEN/NOTIFY is per-database, not cross-cluster. A
  read replica will not see the notifications — the proxy terminates the stream
  for its clients instead.
- **Restart wipes shared memory.** Persisted subscriptions survive, but you must
  call `pgr.restore_subscriptions()` once per database after a restart.

## Performance

Measured on Docker Desktop on Windows (WSL2 backend), 2026-02, with the
temp-table recompute optimization. This is a snapshot from one dev box, not a
benchmark — the same suite has swung 3× with host state. Reproduce it with
`bash tests/perf/runner.sh` (`P1`–`P7`).

| Scenario                          | Throughput | Latency (p50) |
|-----------------------------------|-----------:|--------------:|
| 1 subscription, mixed DML         |  ~222 TPS  |        4.4 ms |
| 10 subscriptions, mixed DML       |   ~99 TPS  |        9 ms   |
| EXCEPT on 1K-row snapshot         |       —    |        2.8 ms |
| EXCEPT on 10K-row snapshot        |       —    |       18.5 ms |
| EXCEPT on 100K-row snapshot       |       —    |      263 ms   |
| Commit-to-NOTIFY end-to-end       |       —    |        3 ms   |
| 200-client WebSocket fan-out      |   0 missed |             — |

## Configuration

| Parameter | Default | Restart? | Description |
|-----------|--------:|----------|-------------|
| `shared_preload_libraries` | — | yes | Must include `pg_reactive`. |
| `pg_reactive.max_subscriptions` | `1024` | yes | Shared memory subscription slots. |
| `pg_reactive.async_recompute` | `off` | yes | Background worker for async recompute. |
| `pg_reactive.database` | `postgres` | yes | Database the worker connects to. Used only when `async_recompute` is on. |
| `pg_reactive.batch_invalidation` | `on` | no (superuser) | Defer recompute to transaction pre-commit: one recompute per query per transaction instead of per statement. |
| `pg_reactive.notify_channel` | `pgr` | no (superuser) | Channel for every delta, overflow and invalidation payload. |

The first four are `PGC_POSTMASTER` and need a restart; the last two are
`PGC_SUSET` and can be changed at runtime by a superuser.

## Testing

17 `pg_regress` files cover subscribe/unsubscribe semantics, column-level
invalidation, GROUP BY / window / HAVING / LEFT JOIN queries, cross-table
dependencies, overflow handling, notify mode, DDL auto-unsubscribe, batch
invalidation, audience filtering, snapshot drift, generation, rollback journal
and upgrade paths:

```bash
make installcheck
```

Four isolation specs cover concurrent DML, concurrent subscribe and concurrent
invalidation:

```bash
make isolation_installcheck
```

A failing regress test writes the diff to `regression.diffs` and the actual
output to `results/`. Trailing whitespace in expected output is significant —
copy from `results/` when updating.

## Layout

```
ext/
  src/
    pg_reactive.c     _PG_init, ProcessUtility hook for DDL, subscribe/unsubscribe
    dependency.c      Shared-memory hash (query_id → tables) with LRU eviction
    invalidation.c    AFTER STATEMENT triggers, column masks, auto-installation
    recompute.c       EXCEPT-based deltas, snapshot tables, NOTIFY emission
    bgworker.c        Optional async-recompute background worker
  pg_reactive--0.1.8.sql     Install script (creates the `pgr` schema)
  pg_reactive--*.sql         Upgrade scripts, 0.1 → 0.1.8
  pg_reactive.control        Extension metadata
  Makefile                   PGXS build
  sql/ expected/             pg_regress tests and their expected output
  specs/                     Isolation specs
```

## License

PostgreSQL License — see [`LICENSE`](LICENSE), the same license PostgreSQL
itself ships under.

## Project home

Developed inside the [pg_reactive / pgStack](https://github.com/ndokutovich/pg_reactive)
monorepo. Issues and PRs about the extension are welcome there — prefix the
title with `ext:` for triage.

- Full backend built on this extension: [`../README.md`](../README.md)
- Security reports: [`../SECURITY.md`](../SECURITY.md)
- Contributing: [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- Changelog: [`../CHANGELOG.md`](../CHANGELOG.md)
