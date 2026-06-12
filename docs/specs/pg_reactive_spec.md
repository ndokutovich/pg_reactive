# pg_reactive Technical Specification

**Version:** 0.1.4
**Last Updated:** 2026-06-11
**Status:** Production-ready (Phase 1 complete)

---

## 1. Overview

pg_reactive is a PostgreSQL C extension that turns standard SQL `SELECT` statements into live queries with real-time delta notifications. When data changes in any table referenced by a subscribed query, pg_reactive automatically recomputes the query, calculates the exact diff (inserted and deleted rows), and delivers the delta as a JSON payload via PostgreSQL `NOTIFY`.

### Three-Layer Architecture

```
Browser / Mobile / Server App
        |
        | WebSocket
        v
pgstack-proxy (Go binary)        <-- Fan-out to N clients
        |
        | LISTEN/NOTIFY on "pgr" channel
        v
PostgreSQL 16 + pg_reactive       <-- C extension
   - Shared memory (ShmemInitHash)
   - LWLocks
   - SPI (Server Programming Interface)
   - AFTER STATEMENT triggers
   - UNLOGGED snapshot tables
   - EXCEPT-based delta computation
```

| Layer | Location | Language | Purpose |
|-------|----------|----------|---------|
| C Extension | `ext/src/` | C | Query subscription, dependency tracking, trigger installation, delta computation, NOTIFY dispatch |
| Go Proxy | `proxy-go/` | Go | WebSocket fan-out, JWT authentication, LISTEN multiplexing |
| TypeScript SDK | `sdk/src/` | TypeScript | Client-side snapshot management, React hooks, reconnection logic |

---

## 2. Core Mechanism

### 2.1 Subscribe Flow

```
pgr.subscribe('orders_q', 'SELECT id, total FROM orders WHERE status = ''active''')
```

0. **Persist catalog row** (since 0.1.4) -- The plpgsql wrapper upserts `(query_id, query_text, mode, audience)` into `pgr.persisted_subscriptions` via `pgr._persist_subscription`, then calls the C-level `pgr._subscribe_internal`, which performs the steps below.

1. **Parse query** -- The raw SQL text is parsed using PostgreSQL's own parser (`raw_parser`). The resulting parse tree is walked recursively to extract table OIDs and per-table column bitmasks.

2. **Extract dependencies** -- Each referenced table is resolved to its OID via `RangeVarGetRelid`. Column references (`ColumnRef` nodes) are mapped to attribute numbers and stored as `uint64` bitmasks (bit N corresponds to `attnum` N+1, supporting up to 64 columns per table).

3. **Allocate shared memory slot** -- A `PgrDepEntry` is inserted into the shared hash table (`ShmemInitHash`). If the table is full (all `max_subscriptions` slots occupied), the entry with the oldest `subscribed_at` timestamp is evicted via LRU, and its snapshot table and triggers are cleaned up.

4. **Create UNLOGGED snapshot table** -- An UNLOGGED table named `pgr._snap_<query_id>` is created via SPI: `CREATE UNLOGGED TABLE pgr._snap_<query_id> AS <query>`. UNLOGGED tables avoid WAL overhead since snapshots are ephemeral.

5. **Install AFTER STATEMENT triggers** -- Base triggers (`pgr_ins_<tableoid>`, `pgr_del_<tableoid>`) are installed for INSERT and DELETE on each dependent table. Per-query UPDATE triggers (`pgr_upd_<tableoid>_<queryid>`) are installed with an `AFTER UPDATE OF <tracked columns>` column list that restricts firing to updates affecting tracked columns only (plain `AFTER UPDATE` when the column mask is all-columns or empty).

6. **Return confirmation** -- Returns a JSONB result: `{"status":"subscribed","tables":N,"mode":"delta","query_id":"..."}`.

### 2.2 Delta Computation (Recompute)

When a DML statement (INSERT, UPDATE, DELETE) executes on a tracked table, the AFTER STATEMENT trigger fires and initiates recomputation:

```sql
-- Conceptual delta computation (actual implementation uses SPI in C):

-- Step 1: Execute user query into a temp table
CREATE TEMP TABLE _pgr_new AS <user_query>;

-- Step 2: Find deleted rows (in old snapshot but not in new result)
SELECT * FROM pgr._snapshot_<query_id>
EXCEPT
SELECT * FROM _pgr_new;

-- Step 3: Find inserted rows (in new result but not in old snapshot)
SELECT * FROM _pgr_new
EXCEPT
SELECT * FROM pgr._snapshot_<query_id>;

-- Step 4: Replace old snapshot with new
DELETE FROM pgr._snapshot_<query_id>;
INSERT INTO pgr._snapshot_<query_id> SELECT * FROM _pgr_new;
DROP TABLE _pgr_new;

-- Step 5: Send delta as NOTIFY
NOTIFY pgr, '{"query_id":"...","inserted":[...],"deleted":[...],"seq":N}';
```

The user query is executed exactly once per DML trigger (into a temp table). The EXCEPT operations then run against the temp table. This is a key optimization: prior implementations executed the user query three times per trigger.

### 2.3 Unsubscribe Flow

```
pgr.unsubscribe('orders_q')
```

1. **Drop snapshot table** -- `DROP TABLE IF EXISTS pgr._snapshot_<query_id>`.
2. **Remove per-query UPDATE triggers** -- Each per-query trigger `pgr_upd_<tableoid>_<queryid>` is dropped from its table.
3. **Remove base triggers if unused** -- If no other subscriptions reference the same table, the base INSERT and DELETE triggers are also removed.
4. **Free shared memory slot** -- The `PgrDepEntry` is removed from the hash table.

### 2.4 Subscription Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `delta` (default) | Full EXCEPT-based diff with snapshots. Sends inserted and deleted row arrays. | Dashboards, live tables, collaborative editing |
| `notify` | Lightweight invalidation signal only. No snapshot table, no EXCEPT. | Cache invalidation, "data changed" hints |

---

## 3. Shared Memory Architecture

### 3.1 Data Structures

```c
typedef struct PgrDepEntry {
    char        query_id[64];          // Hash key (alphanumeric + underscores + hyphens)
    Oid         table_oids[16];        // Up to 16 dependent tables per query
    uint64      col_masks[16];         // Column bitmask per table (64 columns max)
    int         num_tables;            // Number of dependent tables
    char        query_text[2048];      // Original SQL text
    TimestampTz subscribed_at;         // For LRU eviction
    TimestampTz last_invalidated;      // Last trigger fire time
    int64       invalidation_count;    // Total invalidations for this query
    char        mode;                  // 'd' = delta, 'n' = notify
    int64       notify_seq;            // Monotonic sequence for gap detection
    char        audience[512];         // Serialised JSON audience predicate enforced by proxy at WS connect (empty = public; since 0.1.2)
} PgrDepEntry;

typedef struct PgrSharedState {
    LWLock     *lock;                  // Protects all shared state
    int64       subscribe_count;       // Lifetime subscribe calls
    int64       unsubscribe_count;     // Lifetime unsubscribe calls
    int64       invalidation_count;    // Lifetime trigger firings
    int64       eviction_count;        // Lifetime LRU evictions
    int64       recompute_count;       // Lifetime recomputes executed
} PgrSharedState;
```

### 3.2 Memory Layout

Shared memory is requested during `_PG_init` via `shmem_request_hook` and initialized during `shmem_startup_hook`:

- **State header** -- `MAXALIGN(sizeof(PgrSharedState))` containing the LWLock and global counters.
- **Dependency hash table** -- `hash_estimate_size(max_subscriptions, sizeof(PgrDepEntry))` using `ShmemInitHash` with `HASH_ELEM | HASH_STRINGS` flags.
- **Dirty queue** -- `MAXALIGN(sizeof(PgrDirtyQueue))` for the optional background worker.

Total shared memory per subscription slot: approximately 2.8 KB (PgrDepEntry carries a 2048-byte query text field plus a 512-byte audience field).

### 3.3 Concurrency Control

All access to shared memory is protected by a single named LWLock (`pg_reactive`):

- **LW_SHARED** -- Read operations: `pgr_dep_find`, `pgr_dep_find_by_table`, `pgr_dep_count`.
- **LW_EXCLUSIVE** -- Write operations: `pgr_dep_add`, `pgr_dep_remove`, `pgr_dep_increment_seq`, counter updates.

The LWLock is held for the minimum duration necessary. SPI calls (query execution, snapshot operations) are performed outside the lock.

---

## 4. Column-Level Tracking

### 4.1 Bitmask Design

Each table dependency carries a `uint64` column bitmask where bit N corresponds to `attnum` (N+1). This supports up to 64 columns per table.

- `PGR_COL_MASK_ALL` (`~0ULL`) -- Indicates `SELECT *` or expressions that reference all columns.
- Specific bits -- Set for each column referenced in the query (SELECT list, WHERE, JOIN conditions, GROUP BY, ORDER BY, etc.).

### 4.2 Per-Query UPDATE Triggers

Unlike INSERT and DELETE triggers (which are shared across all subscriptions on a table), UPDATE triggers are per-query:

```sql
CREATE TRIGGER pgr_upd_<tableoid>_<queryid>
AFTER UPDATE OF col1, col2, col3
ON <table>
FOR EACH STATEMENT
EXECUTE FUNCTION pgr.trigger_func('<query_id>');
```

The trigger receives `query_id` as `tgarg`. The trigger function checks `tgnargs > 0` to distinguish per-query UPDATE triggers from base INSERT/DELETE triggers.

### 4.3 Column Overlap Check

```c
static inline bool
pgr_columns_overlap(uint64 registered_mask, uint64 updated_mask)
{
    if (registered_mask == (uint64) ~0ULL) return true;   // SELECT *
    if (updated_mask == 0) return true;                    // No info, be conservative
    return (registered_mask & updated_mask) != 0;          // Bitwise AND
}
```

Column skipping is enforced by PostgreSQL itself via the `AFTER UPDATE OF` column list — the trigger never fires for untracked columns. The `pgr_columns_overlap` helper (ext/src/invalidation.h) documents the mask-overlap semantics but is not currently on the trigger fire path.

---

## 5. Batch Invalidation

When `pg_reactive.batch_invalidation` is enabled (default: `true`), pg_reactive uses a per-transaction dirty set instead of recomputing immediately inside each trigger:

1. **Trigger fires** -- Adds the `query_id` to a `PgrDirtyList` allocated in `TopTransactionContext`.
2. **More triggers fire** -- Additional query_ids are appended (deduplicated).
3. **`XACT_EVENT_PRE_COMMIT`** -- The transaction callback iterates the dirty list and recomputes each query_id exactly once.
4. **Transaction ends** -- `TopTransactionContext` is destroyed, automatically freeing the dirty list.

This optimization prevents redundant recomputes when a single transaction performs multiple DML statements affecting the same subscription.

---

## 6. DDL Handling

pg_reactive intercepts DDL statements via a `ProcessUtility_hook`:

| DDL Statement | Action |
|---------------|--------|
| `TRUNCATE <table>` | Calls `pgr_invalidate_table(table_oid)` to recompute all subscriptions depending on the table |
| `ALTER TABLE ... DROP COLUMN` / `ALTER TABLE ... RENAME COLUMN` | Auto-unsubscribes all queries referencing the table (handled pre-DDL; column metadata is about to change/disappear) |
| Other `ALTER TABLE` operations, `ALTER TABLE ... RENAME TO` | Calls `pgr_invalidate_table(table_oid)` to recompute all subscriptions depending on the table (post-DDL) |
| `DROP TABLE <table>` | Auto-unsubscribes all queries referencing the table |

The hook chains to the previous `ProcessUtility_hook` to maintain compatibility with other extensions.

---

## 7. NOTIFY Wire Format

All notifications use a single PostgreSQL channel (configurable via `pg_reactive.notify_channel`, default: `pgr`).

### 7.1 Delta Message

```json
{
  "query_id": "orders_q",
  "inserted": [
    {"id": 42, "total": 99.50, "status": "active"}
  ],
  "deleted": [
    {"id": 37, "total": 25.00, "status": "active"}
  ],
  "seq": 15
}
```

### 7.2 Overflow Message

When the delta JSON exceeds PostgreSQL's NOTIFY payload limit (8000 bytes minus channel name length minus 100 bytes overhead), an overflow signal is sent instead:

```json
{
  "type": "overflow",
  "query_id": "orders_q",
  "seq": 15,
  "fetch": true
}
```

Clients receiving an overflow message should clear their local snapshot and re-fetch the full result set.

An overflow signal is also emitted when the snapshot's column layout has drifted from the live query (e.g. the subscription was re-registered with a different shape under the same query_id, or a snapshot survived from an older deploy). In that case the snapshot is rebuilt server-side and clients must clear local state and re-fetch.

### 7.3 Invalidation Message (notify mode)

Subscriptions registered with `mode => 'notify'` skip delta computation entirely; each trigger fire emits a lightweight invalidation signal:

```json
{
  "type": "invalidated",
  "query_id": "orders_q",
  "seq": 15
}
```

Clients treat this as a "data changed" hint and re-fetch on their own schedule.

### 7.4 Sequence Numbers

Each delta message includes a `seq` field (monotonically increasing per query_id). Clients can detect missed notifications by observing gaps in the sequence. A gap indicates that either:
- A recompute produced no changes for this query (`seq` is a notification-attempt counter incremented before delta computation; when the delta is empty, no NOTIFY is sent and that seq value is silently consumed).
- A NOTIFY was dropped due to queue pressure.

Overflow messages carry their own `seq` field and therefore do not produce gaps.

### 7.5 Proxy Welcome Message

When a WebSocket client connects, the proxy sends:

```json
{
  "type": "subscribed",
  "query_id": "orders_q"
}
```

---

## 8. GUC Parameters

| Parameter | Type | Default | Restart | Description |
|-----------|------|---------|---------|-------------|
| `pg_reactive.max_subscriptions` | `int` | 1024 | Yes (PGC_POSTMASTER) | Maximum concurrent subscriptions. Determines shared memory allocation. |
| `pg_reactive.async_recompute` | `bool` | `off` | Yes (PGC_POSTMASTER) | Enable background worker for asynchronous recompute. |
| `pg_reactive.database` | `string` | `postgres` | Yes (PGC_POSTMASTER) | Database the async-recompute background worker connects to. |
| `pg_reactive.notify_channel` | `string` | `pgr` | No (PGC_SUSET) | NOTIFY channel name for all delta messages. |
| `pg_reactive.batch_invalidation` | `bool` | `true` | No (PGC_SUSET) | Deduplicate recomputes within a transaction. |

---

## 9. SQL Interface

### 9.1 Functions

```sql
-- Subscribe to a live query (delta or notify mode, optional audience).
-- Since 0.1.4 this is a plpgsql wrapper: it first upserts the subscription
-- into pgr.persisted_subscriptions, then calls the C-level
-- pgr._subscribe_internal.
pgr.subscribe(p_query_id text, p_query text,
              p_mode text DEFAULT 'delta',
              p_audience jsonb DEFAULT NULL)
  RETURNS jsonb

-- Unsubscribe from a live query (wrapper over pgr._unsubscribe_internal;
-- also deletes the pgr.persisted_subscriptions row)
pgr.unsubscribe(p_query_id text)
  RETURNS boolean

-- List all active subscriptions
pgr.get_subscriptions()
  RETURNS SETOF record(query_id, query_text, num_tables, subscribed_at,
                       invalidation_count, mode, audience)

-- Extension-wide statistics
pgr.stats()
  RETURNS SETOF record(metric, value)

-- Rebuild the in-memory subscription hash from pgr.persisted_subscriptions
-- after a PG restart wipes shared memory. Idempotent; per-row failures are
-- reported via RAISE WARNING without aborting the restore. SECURITY DEFINER,
-- SET search_path = pg_catalog, pgr. Call from a deploy post-init hook.
pgr.restore_subscriptions()
  RETURNS int  -- number of successfully restored subscriptions
```

#### Persisted subscription catalog (since 0.1.4)

`pgr.persisted_subscriptions` is a LOGGED catalog table (`REVOKE ALL FROM PUBLIC`) that survives server restarts — shared memory does not. Columns: `query_id text PRIMARY KEY`, `query_text text NOT NULL`, `mode text NOT NULL`, `audience jsonb`, `owner_role text DEFAULT current_user`, `created_at` / `updated_at timestamptz`. It is maintained transparently by the `pgr.subscribe` / `pgr.unsubscribe` wrappers via the internal `SECURITY DEFINER` helpers `pgr._persist_subscription(...)` and `pgr._forget_subscription(...)` (both pinned with `SET search_path = pg_catalog, pgr`). After a restart, run `SELECT pgr.restore_subscriptions();` once per database to replay the catalog into shared memory.

#### audience (since 0.1.2)

The optional `audience` argument is a JSON object enforced by the proxy at WebSocket connect time. Every key in the audience must match the corresponding JWT claim; otherwise the connection is rejected with `403 Forbidden`. `service_role` JWTs always bypass.

```sql
-- Public (legacy behaviour): any authenticated client can read.
SELECT pgr.subscribe('online_count', 'SELECT count(*) FROM presence');

-- Bound to a specific user — only the JWT with sub=42 can subscribe.
SELECT pgr.subscribe(
  'inv_42',
  'SELECT name, count FROM player_inventory WHERE player_id = ''42''',
  'delta',
  '{"sub":"42"}'::jsonb);

-- Multi-key: must satisfy ALL keys.
SELECT pgr.subscribe(
  'admin_audit',
  'SELECT * FROM audit_log',
  'delta',
  '{"role":"admin","org":"acme"}'::jsonb);
```

Audience is persisted to `pgr.persisted_subscriptions` (and mirrored in shared memory, max 512 bytes serialised). The proxy reads it from the transactional `pgr.subscription_meta()` — never the non-transactional `pgr.get_subscriptions()` shmem view — on every WS connect, before the initial snapshot, and on every delivered delta; a connection whose claims no longer match the current audience is disconnected (round 37/39). Mismatched claims surface as `403`. NULL audience preserves pre-0.1.2 public behaviour.

### 9.2 Views

```sql
-- Convenience view over pgr.get_subscriptions()
pgr.subscriptions
```

### 9.3 Trigger Function

```sql
-- Installed automatically on tracked tables (SECURITY DEFINER)
pgr.trigger_func()
  RETURNS trigger
```

The trigger function runs as `SECURITY DEFINER` so that recompute and snapshot SPI calls execute as the extension owner regardless of which role performs the DML.

### 9.4 Permissions

`pgr.subscribe` and `pgr.unsubscribe` are revoked from `PUBLIC` by default and
**MUST be treated as a privileged admin API**, not a per-tenant grant.

**Why:** the SQL text passed to `pgr.subscribe` is stored verbatim and later
re-executed by the extension's trigger path. That path runs as `SECURITY
DEFINER` (the extension owner — typically `postgres` or `pgstack_admin`),
so anything the caller can put into the query string runs with elevated
privileges on every relevant DML.

A role that holds `EXECUTE` on `pgr.subscribe` and ALSO has `CREATE` on any
schema in its `search_path` (e.g. `public`) can:

1. `CREATE FUNCTION attacker_payload() RETURNS int LANGUAGE plpgsql AS $$ ... $$`
   under its own privileges, and then
2. Subscribe a query like `SELECT attacker_payload() FROM pg_namespace LIMIT 1`,
3. Which the extension's `SECURITY DEFINER` trigger path then evaluates on every
   matching DML — running the attacker's function as the extension owner.

This is a privilege boundary, not a usage convenience.

**Do NOT do this (footgun):**

```sql
-- ❌ Grants every app user the ability to register arbitrary SQL that
--    later runs SECURITY DEFINER. Combined with CREATE FUNCTION (which
--    most authenticated roles have on the public schema) this is a
--    DEFINER-context RCE.
GRANT EXECUTE ON FUNCTION pgr.subscribe(text, text, text, jsonb) TO myapp_role;
GRANT EXECUTE ON FUNCTION pgr.unsubscribe(text) TO myapp_role;
```

**Recommended pattern: SECURITY DEFINER wrappers with fixed SQL.**

Keep `pgr.subscribe`/`unsubscribe` available only to your admin role
(typically `postgres` / `service_role`). Expose subscription registration
to application clients through purpose-built `SECURITY DEFINER` wrappers
that inject a constant query template and derive the `query_id` and
audience from server-side state:

```sql
-- Define ONE wrapper per query shape your app needs to subscribe to.
-- The SQL text is a literal string the app cannot influence; only the
-- arguments are taken from the caller.
--
-- pgr.subscribe signature (see ext/pg_reactive--0.1.4.sql):
--   pgr.subscribe(p_query_id text, p_query text, p_mode text DEFAULT 'delta',
--                 p_audience jsonb DEFAULT NULL) RETURNS jsonb
-- `p_mode` is the delivery mode ('delta' = ship inserted/deleted rows on
-- NOTIFY, 'notify' = ship a bare invalidation signal). It is NOT a role
-- and the function does not switch identity per call.
CREATE FUNCTION public.subscribe_my_orders(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp  -- ⚠ NO public; closes search-path attack
AS $$
DECLARE
  qid text := 'orders_' || p_user::text;
BEGIN
  -- AuthZ check the wrapper enforces. The wrapper IS the gate: callers
  -- only ever reach pgr.subscribe via this function, so the JWT-sub
  -- match below is what binds a subscription to its owner.
  IF p_user IS DISTINCT FROM (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid THEN
    RAISE EXCEPTION 'forbidden: caller may only subscribe to own orders';
  END IF;
  RETURN pgr.subscribe(
    qid,
    format('SELECT id, status, total FROM public.orders WHERE user_id = %L', p_user),
    'delta',                                  -- delivery mode (delta | notify)
    jsonb_build_object('sub', p_user::text)   -- audience binding: only JWTs with this sub receive deltas
  );
END $$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_orders(uuid) TO authenticated;
-- pgr.subscribe itself stays revoked from authenticated.
```

The wrapper:

- has a **fixed query template** the caller cannot rewrite,
- derives `query_id` and the audience filter from `auth.uid()` so a caller
  cannot subscribe to someone else's stream,
- runs `SET search_path = pg_catalog, pg_temp` (no `public`) so a malicious
  function shadowing `format()` / `pgr.subscribe` in `public` can never be
  resolved by the wrapper body,
- enforces its own application-level authorisation before delegating.

If you cannot use wrappers (e.g. truly admin-only tooling), grant
`pgr.subscribe` only to a dedicated admin role and never to a role that
also holds `CREATE` on any schema on the `search_path`.

---

## 10. Supported Query Types

pg_reactive supports any `SELECT` statement that PostgreSQL can parse and execute:

| Category | Examples |
|----------|----------|
| **Basic** | `SELECT`, `WHERE`, `ORDER BY`, `LIMIT/OFFSET`, `DISTINCT` |
| **Joins** | `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN` |
| **Aggregates** | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `array_agg`, `string_agg` |
| **Grouping** | `GROUP BY`, `HAVING` |
| **Subqueries** | Scalar subqueries, `IN (SELECT ...)`, `EXISTS (SELECT ...)` |
| **CTEs** | `WITH ... AS (SELECT ...)`, `WITH RECURSIVE` |
| **Lateral** | `LATERAL JOIN`, `LATERAL (SELECT ...)` |
| **Window Functions** | `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `LEAD()`, `LAG()`, `NTILE()` |
| **Expressions** | `CASE WHEN`, `COALESCE`, `NULLIF`, type casts |
| **Set Operations** | `UNION`, `INTERSECT`, `EXCEPT` (within the user query itself) |

### Limitations

- Maximum 16 dependent tables per subscription (`PGR_MAX_DEPS_PER_QUERY`).
- Maximum 64 tracked columns per table (uint64 bitmask).
- Query text limited to 2048 characters (`PGR_QUERY_TEXT_LEN`).
- Query ID limited to 64 characters, alphanumeric plus underscores and hyphens.
- NOTIFY payload limit of approximately 7900 bytes for the default `pgr` channel — computed at runtime as 8000 minus the channel-name length minus 100 bytes overhead (see `PGR_NOTIFY_MAX_PAYLOAD_FOR_CHANNEL` in ext/src/recompute.c). Larger deltas produce overflow signals.

---

## 11. LRU Eviction

When all shared memory slots are occupied and a new subscription is requested:

1. The entry with the smallest `subscribed_at` timestamp is identified.
2. Its snapshot table is dropped and triggers are removed.
3. The shared memory slot is reused for the new subscription.
4. The `eviction_count` counter is incremented.
5. A LOG-level message is emitted identifying the evicted query_id (`elog(LOG, ...)` in ext/src/dependency.c).

Eviction information is returned in the `PgrEvictedInfo` struct so the caller can perform cleanup (drop triggers, snapshot tables) outside the LWLock.

---

## 12. Background Worker (Optional)

When `pg_reactive.async_recompute = on`, a background worker process is registered:

- **Listens on a shared dirty queue** -- Trigger functions push table OIDs to a `PgrDirtyQueue` (spinlock-protected, 4096 slots — `PGR_DIRTY_QUEUE_SIZE`).
- **Wakes via Latch** -- Trigger functions set the worker's latch after pushing to the queue.
- **Processes in bulk** -- The worker drains the queue, looks up affected query_ids via the reverse index (`table_oid -> query_ids`), and recomputes each.
- **Runs in its own transaction** -- Recomputes happen in a separate transaction from the triggering DML.

This mode trades consistency (delta may arrive slightly after the transaction commits) for lower latency on the DML path.

---

## 13. Source File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `ext/src/pg_reactive.c` | ~1000 | `_PG_init`, `pgr.subscribe`, `pgr.unsubscribe`, query parsing, dependency extraction, DDL hook |
| `ext/src/pg_reactive.h` | ~135 | Shared data structures, constants, inline helpers |
| `ext/src/dependency.c` | ~400 | Shared memory hash table (add, remove, find, LRU eviction, reverse index) |
| `ext/src/invalidation.c` | ~1000 | AFTER STATEMENT triggers, per-transaction dirty list, batch invalidation, DDL ProcessUtility hook |
| `ext/src/invalidation.h` | ~55 | Trigger installation API, column overlap inline function |
| `ext/src/recompute.c` | ~650 | EXCEPT-based delta computation, JSON serialization, NOTIFY dispatch |
| `ext/src/recompute.h` | ~25 | Recompute API, JSON escape function |
| `ext/src/bgworker.c` | ~230 | Optional background worker, dirty queue |
| `ext/src/bgworker.h` | ~45 | Background worker API, dirty queue structure |
| `ext/pg_reactive--0.1.4.sql` | ~230 | Current full install script (`default_version = 0.1.4`; base scripts 0.1–0.1.3 plus three upgrade scripts also ship — 8 SQL files total) |
| `ext/pg_reactive.control` | ~5 | Extension metadata |

---

## 14. Performance Baselines

Measured on Docker (Windows 11 host, WSL2), PostgreSQL 16, March 2026:

| Metric | Value |
|--------|-------|
| 1 subscription throughput | ~222 TPS, 4.4 ms p50 |
| 10 subscriptions throughput | ~99 TPS, 9 ms p50 |
| EXCEPT on 1K rows | 2.8 ms p50 |
| EXCEPT on 10K rows | 18.5 ms p50 |
| EXCEPT on 100K rows | 263 ms p50 |
| End-to-end pipeline latency (DB to client) | 3 ms p50 |
| Fan-out at 200 WebSocket clients | 0 missed deltas |
| Fan-out at 500 WebSocket clients | Degradation begins |
| 3-minute soak test | 100% delivery, ~3x drift |

The temp-table optimization (executing the user query once instead of three times per trigger) yielded an 8x improvement at 1 subscription and a 33x improvement at 10 subscriptions compared to the pre-optimization baseline.

---

## 15. Critical Implementation Notes

### SPI Memory Context

Always call `initStringInfo` **before** `SPI_connect()`. SPI_connect switches the memory context to a temporary SPI context that is destroyed by `SPI_finish()`. Any allocations made in the SPI context become invalid after `SPI_finish()`.

### Trigger Snapshot Visibility

AFTER STATEMENT triggers cannot see the triggering DML via SPI by default. The fix:

```c
SPI_connect();
PopActiveSnapshot();
CommandCounterIncrement();
PushActiveSnapshot(GetTransactionSnapshot());
```

### SPI Temp Table Visibility

When creating temp tables inside SPI, use `read_only=false` for subsequent SPI_execute calls that need to read from the temp table. Using `read_only=true` would use `GetActiveSnapshot()` which has a stale command counter.

### TRUNCATE Inside Triggers

Use `DELETE` instead of `TRUNCATE` for snapshot tables inside trigger SPI context. TRUNCATE on UNLOGGED tables inside trigger SPI can leave tables empty.

---

## 16. Testing

| Test Type | Count | Command |
|-----------|-------|---------|
| pg_regress (SQL) | 12 files | `make installcheck` |
| Isolation (concurrency) | 3 specs | `make isolation_installcheck` |
| Integration (Python) | 3 scripts | `test_shmem_pressure.py`, `test_notify_throughput.py`, `test_lru_eviction.py` |
| E2E (Node.js) | 4 scripts (realtime core) | `e2e_ws_test.mjs`, `e2e_fanout_test.mjs`, `e2e_jwt_test.mjs`, `e2e_gzip_test.mjs` (10 further pgStack-level `e2e_*.mjs` scripts live in `tests/`) |
| Performance (P1-P7) | 7 benchmarks | `tests/perf/runner.sh` |
