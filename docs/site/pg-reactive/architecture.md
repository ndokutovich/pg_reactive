---
title: Architecture
sidebar_position: 8
description: A map of how the pg_reactive extension is built internally — the five C modules, shared memory, triggers, and the recompute path.
---

This page is a map, not a re-implementation. It walks the five C modules that make up the extension, how shared memory ties them together, and the few correctness rules that keep the recompute path sound. It is written for advanced users and contributors who want to read or modify `ext/src/`. For the full design rationale, see [`docs/specs/pg_reactive_spec.md`](https://github.com/ndokutovich/pg_reactive/blob/master/docs/specs/pg_reactive_spec.md) in the repository.

If you only want to *use* the extension, start with [Overview](./overview.md) and [Subscribe](./subscribe.md). If you want to know what runs in front of the database, see [Proxy](./proxy.md).

## The big picture

The extension lives entirely inside PostgreSQL. There is no daemon, no sidecar — `pg_reactive` is loaded via `shared_preload_libraries`, it parses your `SELECT` once at subscribe time to learn which tables and columns it depends on, then installs `AFTER STATEMENT` triggers that recompute the query and emit a JSON delta over a single `NOTIFY` channel. A separate [Go proxy](./proxy.md) does `LISTEN pgr` and fans those deltas out to WebSocket clients.

```
DML on a tracked table
        │
        ▼
AFTER STATEMENT trigger  (invalidation.c)
        │  mark query_id dirty
        ▼
XACT_EVENT_PRE_COMMIT     (invalidation.c — batch invalidation)
        │  recompute each dirty query once
        ▼
EXCEPT-based delta         (recompute.c)
        │  build JSON, check overflow
        ▼
NOTIFY pgr '{...}'   ───►  Go proxy LISTEN pgr  ───►  WebSocket clients
```

Everything the proxy needs to authorize a connection — query SQL, mode, audience — lives in shared memory, indexed by `query_id`. That index is the spine of the whole system.

## The five modules

| File | Role |
|------|------|
| `ext/src/pg_reactive.c` | Entry point, SQL functions, query parsing, dependency extraction, DDL hook registration |
| `ext/src/dependency.c` | Shared-memory hash table, reverse index, LRU eviction, transaction rollback journal |
| `ext/src/invalidation.c` | `AFTER STATEMENT` triggers, batch invalidation, `ProcessUtility_hook` for DDL |
| `ext/src/recompute.c` | EXCEPT-based delta, JSON serialization, NOTIFY dispatch and overflow |
| `ext/src/bgworker.c` | Optional background worker for asynchronous recompute |

### `pg_reactive.c` — entry point and query parsing

`_PG_init()` is the load hook. It registers the shared-memory request/startup hooks, installs the `ProcessUtility_hook` (chaining to any previous one), wires up the transaction callbacks, and defines the five GUCs documented in [GUCs](./gucs.md).

The SQL surface is here too — the C functions behind the `pgr` API:

- `pgr_subscribe` / `pgr_unsubscribe` — the internal workers behind `pgr.subscribe()` / `pgr.unsubscribe()`.
- `pgr_get_subscriptions` — backs `pgr.get_subscriptions()`.
- `pgr_stats` — backs `pgr.stats()`; counters accumulate over the server lifetime.

The interesting work in this module is **dependency extraction**. When you subscribe, the raw SQL text is fed through PostgreSQL's own parser (`raw_parser`), and the resulting parse tree is walked recursively (`pgr_extract_from_node`, `pgr_extract_from_select`, `pgr_extract_columns_from_node`). Two things come out:

1. **Table OIDs** — every base relation the query touches, resolved via `RangeVarGetRelid`. Up to 16 tables per query (`PGR_MAX_DEPS_PER_QUERY`).
2. **Column bitmasks** — a `uint64` per table where bit *N* corresponds to `attnum` *N+1*, so up to 64 columns are tracked per table. `SELECT *` or whole-row references set the all-ones mask `PGR_COL_MASK_ALL` (`~0ULL`).

These two facts — *which tables, which columns* — are what let the extension install precise triggers and skip recomputes for irrelevant column updates.

`pg_reactive.c` also owns `pgr_unsubscribe_all_for_table()`, the routine the DDL hook calls when a table is dropped or reshaped out from under a subscription.

### `dependency.c` — shared memory, reverse index, eviction, rollback

This is the state core. It owns a single shared hash table (`pgr_dep_hash`, via `ShmemInitHash`) mapping `query_id` → a `PgrDepEntry`. Each entry carries the dependent table OIDs, their column masks, the original SQL text, the delivery mode, the audience predicate, the monotonic `notify_seq`, and the `subscribed_at` timestamp used for eviction. All access is serialized by one named `LWLock` (`pg_reactive`): `LW_SHARED` for finds, `LW_EXCLUSIVE` for mutations. The lock is held only around the hash operation — SPI work happens outside it.

Three mechanisms are worth understanding:

**Reverse index (table → queries).** Recompute starts from a table OID (a trigger fired on *this* table) and needs the set of `query_id`s that depend on it. Rather than a second persistent index, the lookup walks the hash (`hash_seq_init`) and matches table OIDs in each entry's dependency array. This keeps the structure simple: one hash, scanned in reverse when a table changes.

**LRU eviction.** When all `max_subscriptions` slots are full and a new subscribe arrives, the entry with the oldest `subscribed_at` is evicted. Note: PostgreSQL's internal hash rounds segment counts up to a power of two, so `HASH_ENTER_NULL` may never actually return `NULL` for small sizes — the code checks `hash_get_num_entries() >= pgr_max_subscriptions` explicitly before inserting. The evicted entry's details are returned in a `PgrEvictedInfo` struct so the caller can drop its snapshot table and triggers *outside* the lock, and a `LOG`-level line names the evicted `query_id`.

**Transaction rollback journal (before-image).** Shared memory is not transactional — a hash insert is visible immediately and does not roll back if the surrounding transaction aborts. Left uncorrected, an aborted `subscribe` would leave an orphan shmem entry with no catalog row; an aborted unsubscribe would leave a catalog row with no shmem entry. So before every mutation, `pgr_journal_record()` captures the key's *before-image* (its prior value, or a tombstone meaning "was absent") tagged with the current `SubTransactionId`. On `XACT_EVENT_ABORT` the journal is replayed (`pgr_journal_revert`) to restore shared memory; on subtransaction abort only that subxact's records are reverted; on subtransaction *commit* the records are re-tagged to the parent so a later parent abort still undoes them. The journal lives in its own memory context and is discarded at any terminal top-level event. LRU evictions are journaled too, so an aborted subscribe that evicted a victim restores the victim.

### `invalidation.c` — triggers, batching, DDL

This module is the write-side hook surface.

**AFTER STATEMENT triggers.** On subscribe, base triggers `pgr_ins_<tableoid>` and `pgr_del_<tableoid>` are installed for INSERT and DELETE on each dependent table (shared across all subscriptions on that table). UPDATE triggers are **per-query** — `pgr_upd_<tableoid>_<queryid>` — created with an `AFTER UPDATE OF <tracked columns>` column list so PostgreSQL itself never fires them for untracked-column updates. The shared trigger function is `pgr_trigger_func`; per-query UPDATE triggers pass the `query_id` as `tgarg`, and the function distinguishes them from base triggers by checking `tgnargs > 0`. Triggers are auto-removed on unsubscribe — base triggers only when no other subscription still references the table.

**Batch invalidation.** With `pg_reactive.batch_invalidation` on (the default), a fired trigger does *not* recompute inline. It appends the `query_id` to a per-transaction dirty list allocated in `TopTransactionContext` (deduplicated). At `XACT_EVENT_PRE_COMMIT` the transaction callback iterates the dirty set and recomputes each query exactly once — collapsing many DML statements in one transaction into one recompute per subscription. SPI is available at PRE_COMMIT because the transaction is still open. `TopTransactionContext` is torn down at transaction end, freeing the list automatically. See [GUCs](./gucs.md) for the toggle.

**DDL via `ProcessUtility_hook`.** DDL never fires DML triggers, so the extension intercepts it. The hook chains to any previous `ProcessUtility_hook` and splits its work around the actual DDL:

| DDL | When | Action |
|-----|------|--------|
| `DROP TABLE` | pre-DDL | Auto-unsubscribe every query on that table (`pgr_unsubscribe_all_for_table`) — the table is about to vanish |
| `ALTER TABLE … DROP COLUMN` / `RENAME COLUMN` (a `RenameStmt`) | pre-DDL | Auto-unsubscribe — the column metadata the masks depend on is changing |
| `TRUNCATE` | post-DDL | `pgr_invalidate_table()` — recompute all dependents (the rows are gone, the shape is intact) |
| Other `ALTER TABLE`, `RENAME TO` | post-DDL | `pgr_invalidate_table()` — recompute all dependents |

Auto-unsubscribe runs *before* the DDL because once the column or table is gone, the stored SQL can no longer be parsed or its masks interpreted.

### `recompute.c` — delta, JSON, NOTIFY, overflow

Given a `query_id`, recompute produces the diff. The shape of the work, in `delta` mode:

1. Execute the user query **once** into a temp table. (Earlier implementations ran it three times per trigger; running it once is the optimization behind the published throughput numbers.)
2. `temp EXCEPT snapshot` → inserted rows; `snapshot EXCEPT temp` → deleted rows. The snapshot is an `UNLOGGED` table `pgr._snap_<query_id>` (UNLOGGED because snapshots are ephemeral — no WAL, and they do not survive a crash or restart).
3. Replace the snapshot with the new result (`DELETE` + `INSERT` — not `TRUNCATE`; see the rules below).
4. Serialize inserted/deleted rows to JSON (`pgr_build_delta_json`, `pgr_rows_to_json_array`) and emit `NOTIFY pgr '{...}'`.

In `notify` mode there is no snapshot and no EXCEPT — each fire emits a bare `{"type":"invalidated","query_id":"...","seq":N}` and the client re-fetches on its own. The exact message shapes are in [Wire Format](./wire-format.md).

**Sequence numbers.** Each entry carries a monotonic `notify_seq`, incremented per recompute attempt *before* the delta is computed. If the delta is empty, no NOTIFY is sent and that seq value is silently consumed — which is why clients can legitimately see gaps in `seq` without a notification ever being dropped.

**Overflow.** PostgreSQL caps a NOTIFY payload at 8000 bytes. The threshold here is `8000 - len(channel) - 100` (7897 for the default `pgr`). When the delta JSON would exceed it, the extension sends `{"type":"overflow",...,"fetch":true}` instead and the client clears its snapshot and re-fetches. Overflow also fires when the snapshot's column layout has drifted from the live query (e.g. an `ALTER TABLE` reshaped the result) — the snapshot is rebuilt server-side and clients re-fetch.

### `bgworker.c` — optional async recompute

When `pg_reactive.async_recompute = on` (a `PGC_POSTMASTER` GUC — restart required), `_PG_init` registers a background worker. Triggers then push table OIDs onto a spinlock-protected shared `PgrDirtyQueue` (4096 slots, `PGR_DIRTY_QUEUE_SIZE`) and set the worker's latch instead of recomputing on the DML path. The worker loop is the textbook shape: `WaitLatch` → `ResetLatch` → `pgr_dirty_queue_drain` → look up affected `query_id`s via the reverse index → recompute, each in its own transaction. It connects to the database named by `pg_reactive.database` (default `postgres`). This trades a small consistency delay (the delta may land just after commit) for getting recompute off the writer's critical path. Two contributor gotchas live here: the worker entry point needs `PGDLLEXPORT` under hidden-visibility builds, and it must call `BackgroundWorkerUnblockSignals()` early or SIGTERM stays blocked and PostgreSQL cannot shut down.

## Correctness rules you must not break

These are load-bearing. Three SPI pitfalls and one TRUNCATE pitfall account for most of the intermittent bugs this code has survived.

**Initialize StringInfo before `SPI_connect()`.** `SPI_connect()` switches to a temporary memory context that `SPI_finish()` destroys. Anything allocated after connect — including a `StringInfo` buffer — is freed by `SPI_finish()`, so touching it afterward is a use-after-free.

```c
StringInfoData buf;
initStringInfo(&buf);   /* BEFORE connect — lives in the caller's context */
SPI_connect();
/* ... build SQL into buf, SPI_execute ... */
SPI_finish();
/* buf is still valid here */
```

**Make the triggering DML visible.** An `AFTER STATEMENT` trigger cannot see its own triggering DML through SPI by default. After connecting, refresh the snapshot:

```c
SPI_connect();
PopActiveSnapshot();
CommandCounterIncrement();
PushActiveSnapshot(GetTransactionSnapshot());
```

**Read temp tables with `read_only = false`.** After `CREATE TEMP TABLE … AS SELECT` inside SPI, the active snapshot has a stale command counter and will not see the new rows. Passing `read_only = false` to subsequent `SPI_execute` calls forces a fresh `GetTransactionSnapshot()` that sees them; `read_only = true` would reuse the stale `GetActiveSnapshot()`.

**`DELETE`, not `TRUNCATE`, for snapshots inside triggers.** `TRUNCATE` on an UNLOGGED table inside trigger SPI context can leave the table empty. Use `DELETE` — for snapshot-sized tables the cost difference is negligible.

## Where to go next

- [Subscribe](./subscribe.md) — the SQL API that drives all of the above.
- [Wire Format](./wire-format.md) — the exact NOTIFY message shapes recompute emits.
- [GUCs](./gucs.md) — the five tunables, including `batch_invalidation` and `async_recompute`.
- [Security Model](./security-model.md) — why `pgr.subscribe` is a privileged API and how `SECURITY DEFINER` triggers shape the trust boundary.
- [Proxy](./proxy.md) — the `LISTEN pgr` fan-out layer in front of the channel.
- The full design lives in [`docs/specs/pg_reactive_spec.md`](https://github.com/ndokutovich/pg_reactive/blob/master/docs/specs/pg_reactive_spec.md).

pg_reactive is a standalone PostgreSQL extension; [pgStack](/quickstart) is the batteries-included umbrella that ships it pre-wired with auth, REST, and the proxy if you would rather not assemble the pieces yourself.
