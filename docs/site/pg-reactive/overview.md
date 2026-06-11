---
title: Overview
sidebar_position: 1
description: pg_reactive is a PostgreSQL C extension that turns any SELECT into a live query with column-level delta tracking, computed in SQL and pushed over LISTEN/NOTIFY.
slug: /
---

# pg_reactive

**pg_reactive** is a PostgreSQL C extension that turns any `SELECT` into a
**live query**. You register a query once; from then on, every `INSERT`,
`UPDATE`, or `DELETE` that changes its result set produces a JSON delta —
the exact rows that appeared and disappeared — delivered over PostgreSQL's
own `LISTEN`/`NOTIFY`.

There are no background services, no logical replication slot, and no
external coordinator. The diff is computed inside the database, at the SQL
layer, by the extension. The whole interface is two function calls and a
`LISTEN`:

```sql
CREATE EXTENSION pg_reactive;

-- Register a live query under a stable id.
SELECT pgr.subscribe('orders_active', $$
    SELECT id, customer_id, total, status
    FROM orders
    WHERE status IN ('open', 'pending')
$$);

-- Listen on the single notification channel.
LISTEN pgr;

-- Any DML that affects the query now emits a delta:
INSERT INTO orders (customer_id, total, status) VALUES (42, 99.99, 'open');
-- → NOTIFY pgr, '{"query_id":"orders_active","seq":1,
--    "inserted":[{"id":7,"customer_id":42,"total":99.99,"status":"open"}],
--    "deleted":[]}'
```

Any client that can run `LISTEN pgr` — `psql`, libpq, pgx, JDBC, asyncpg,
the `pg` Node driver — can drive a live UI straight off this stream. No
SDK and no proxy are required to use the extension.

> All SQL objects live in the **`pgr`** schema (not `pg_reactive` — the
> `pg_` prefix is reserved by PostgreSQL for system schemas).

## Why query-level, not WAL-level

Traditional change-data-capture systems (logical decoding, Debezium,
WAL-tailing realtime layers) deliver **raw row events**: every `INSERT`,
`UPDATE`, and `DELETE` on every row of a watched table. The client is then
responsible for figuring out whether any given event actually affects what
it cares about. That has three consequences:

- The client must understand your data model to know if a change matters.
- Filtered queries (`WHERE status = 'active'`) require re-implementing the
  filter on the client.
- Aggregates and JOINs cannot be subscribed to at all — there is no row
  event for "the `COUNT(*)` changed."

pg_reactive subscribes at the **query level** instead. If you subscribe to
`SELECT * FROM orders WHERE status = 'active'`, you receive a delta only
when the *active orders set* changes. Because tracking is **column-level**,
an `UPDATE orders SET notes = '…'` — touching a column your query never
selects or filters on — triggers no notification and does no work. And
because the diff is the output of your actual SQL, the things WAL events
can't express come for free:

- filtered queries (`WHERE`)
- aggregates (`GROUP BY`, `COUNT`, `SUM`, `HAVING`)
- window functions
- multi-table `JOIN`s and cross-table dependencies

The client receives the *answer to its question* changing, not a firehose
of row mutations it has to interpret. See [Query Support](./query-support.md)
for the full list of what is subscribable.

## The three layers

pg_reactive ships as three independent layers. Only the first is required.

### 1. The extension (the core — usable alone)

The C extension lives entirely inside PostgreSQL. It does the real work:
parsing your query, tracking which tables and columns it depends on,
installing triggers, computing the EXCEPT diff, and emitting the delta via
`NOTIFY`. With nothing but a raw `LISTEN pgr` connection you have a
complete reactive system. This is the default narrative for this
documentation: **you, a Postgres user, using the extension directly.**

See [Install](./install.md) and [Subscribe](./subscribe.md).

### 2. A WebSocket fan-out proxy (optional)

`NOTIFY` is per-connection: every client that wants deltas needs its own
`LISTEN`ing database connection, which doesn't scale to thousands of
browsers. The Go proxy (`proxy-go/`) holds a single `LISTEN pgr`
connection to PostgreSQL and **fans out** each delta to all subscribed
WebSocket clients. Browsers connect to
`ws://127.0.0.1:8080/ws/{query_id}` and receive the matching deltas,
with optional JWT (HS256) authentication.

A Rust reference proxy (`proxy/`) exists as well; the Go proxy is the
primary, production implementation. See [Proxy](./proxy.md).

### 3. A TypeScript SDK (optional)

The `@pgstack/sdk` package wraps the WebSocket connection, maintains a
local copy of the result set, applies each delta for you, and handles
reconnection and overflow re-fetch. A React hook (`useLiveQuery`) binds a
live query straight to component state.

See [SDK](./sdk.md) and [React](./react.md).

```
Browser / mobile / server app
        │  WebSocket  (layer 3: optional SDK)
        ▼
  WebSocket proxy            (layer 2: optional fan-out)
        │  LISTEN pgr
        ▼
PostgreSQL + pg_reactive     (layer 1: the extension — the core)
```

You can stop at any layer. Raw `LISTEN pgr` from a backend job is a
perfectly valid deployment; the proxy and SDK exist to make the
browser-facing case easy, not to be mandatory.

## How it works

When you call `pgr.subscribe()`, the extension:

1. **Parses the query** with PostgreSQL's own parser and walks the parse
   tree to extract the table OIDs it depends on and a per-table column
   bitmask (which columns actually matter).
2. **Stores the dependency** in an `LWLock`-protected shared-memory hash
   (`ShmemInitHash`) keyed by `query_id`, with LRU eviction when all
   `pg_reactive.max_subscriptions` slots are full.
3. **Creates an UNLOGGED snapshot table** — `pgr._snap_<query_id>` —
   holding the current result set. UNLOGGED avoids WAL overhead because
   snapshots are ephemeral.
4. **Installs `AFTER STATEMENT` triggers** for INSERT, UPDATE, and DELETE
   on each dependent table. UPDATE triggers carry the column mask, so
   updates to untracked columns skip the work entirely. A
   `ProcessUtility_hook` watches for `TRUNCATE`, `ALTER`, and `DROP` on
   subscribed tables and auto-unsubscribes or re-snapshots as needed.

Then, whenever a tracked DML statement commits, the firing trigger:

1. Re-runs your `SELECT` **once** into a temp table.
2. Computes the delta with two `EXCEPT` operations against the
   `pgr._snap_<query_id>` snapshot: rows in the snapshot but not the new
   result are `deleted`; rows in the new result but not the snapshot are
   `inserted`.
3. Replaces the snapshot with the new result.
4. Emits the delta with `pg_notify('pgr', …)`.

```
DML on a tracked table
   │
   ▼
AFTER STATEMENT trigger (column-mask gated)
   │  re-run SELECT once → temp table
   ▼
EXCEPT diff  vs  pgr._snap_<query_id>  (UNLOGGED snapshot)
   │  inserted = new − snapshot ;  deleted = snapshot − new
   ▼
NOTIFY pgr  '{"query_id":…,"seq":N,"inserted":[…],"deleted":[…]}'
```

When `mode = 'notify'`, no snapshot or EXCEPT is involved — the trigger
just emits a bare `{"type":"invalidated",…}` signal and the client
re-fetches on its own schedule. See [Wire Format](./wire-format.md) for
every message shape, including the **overflow** message emitted when a
delta would exceed PostgreSQL's 8 KB `NOTIFY` limit or when a watched
table's column layout drifts (e.g. after `ALTER TABLE`).

## When to use standalone vs via pgStack

pg_reactive is a self-contained extension; you do not need anything else
to use it. Reach for the umbrella only when you want the batteries.

**Use the extension standalone when:**

- You already run PostgreSQL and want live queries inside your existing
  app or backend.
- Your consumers are server-side (jobs, workers, other services) and can
  hold a `LISTEN pgr` connection directly.
- You want the smallest possible surface: `CREATE EXTENSION`, two
  functions, one channel. No new processes to operate.
- You want fan-out to browsers but will run only the proxy, wiring it into
  your own stack.

**Use [pgStack](/quickstart) when:**

- You want a full, Supabase-compatible backend out of the box — auth,
  PostgREST-style REST/RPC, storage, edge functions, a Studio UI, a CLI
  scaffolder — with pg_reactive's realtime already wired in.
- You'd rather adopt an opinionated, batteries-included platform than
  assemble the proxy + SDK + auth yourself.

pgStack **bundles** this exact extension; everything in this documentation
is true whether you run pg_reactive bare or inside the umbrella. The only
difference is how much surrounding machinery comes pre-assembled.

## Next steps

- [Install](./install.md) — build the extension, `shared_preload_libraries`,
  `CREATE EXTENSION`.
- [Subscribe](./subscribe.md) — `pgr.subscribe()`, modes, the rest of the
  SQL API.
- [pgStack quickstart](/quickstart) — the batteries-included platform built
  on top of this extension.
