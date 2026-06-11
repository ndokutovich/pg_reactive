---
title: The Subscription API
sidebar_position: 3
description: Register and manage live queries with the pgr.subscribe family of SQL functions.
---

# The Subscription API

Everything pg_reactive does starts with a single SQL call: `pgr.subscribe()`. You hand it a `SELECT` and a stable id; from then on, any DML that changes that query's result set produces a JSON delta on the `pgr` NOTIFY channel. No background service, no replication slot — just functions in the `pgr` schema and PostgreSQL's own `LISTEN`/`NOTIFY`.

All functions live in the `pgr` schema — **not** `pg_reactive`, because the `pg_` prefix is reserved by PostgreSQL for system schemas.

:::warning Privileged API
`pgr.subscribe()` stores raw SQL that the extension later re-executes from a `SECURITY DEFINER` trigger path. Granting `EXECUTE` to an application role is a definer-context RCE waiting to happen. By default every `pgr` function is revoked from `PUBLIC`. Read [the security model](./security-model.md) before you grant anything to anyone but your admin role.
:::

## Quick reference

| Function | Returns | Purpose |
|----------|---------|---------|
| `pgr.subscribe(p_query_id text, p_query text, p_mode text DEFAULT 'delta', p_audience jsonb DEFAULT NULL)` | `jsonb` | Register a live query. |
| `pgr.unsubscribe(p_query_id text)` | `boolean` | Remove a subscription. `false` if it did not exist (safe no-op). |
| `pgr.get_subscriptions()` | `setof record` | List active in-memory subscriptions. |
| `pgr.restore_subscriptions()` | `int` | Replay the durable catalog into shared memory after a restart. |
| `pgr.stats()` | `setof (metric text, value text)` | Lifetime extension counters. |

A convenience view, `pgr.subscriptions`, wraps `pgr.get_subscriptions()` for ad-hoc inspection.

---

## pgr.subscribe

```sql
pgr.subscribe(
  p_query_id  text,
  p_query     text,
  p_mode      text  DEFAULT 'delta',
  p_audience  jsonb DEFAULT NULL
) RETURNS jsonb
```

Register `p_query` as a live query under the identifier `p_query_id`. The query must be a pure `SELECT` — DML, DDL, and writable CTEs are rejected. On success, pg_reactive:

1. Parses the SQL to extract the table OIDs it depends on and a per-table column bitmask.
2. Installs `AFTER STATEMENT` triggers (INSERT/UPDATE/DELETE) on each depended-on table.
3. Creates the `UNLOGGED` snapshot table `pgr._snap_<query_id>` and runs the query once to seed it.
4. Records the subscription in the durable catalog `pgr.persisted_subscriptions` so it can be restored after a restart.

### Arguments

**`p_query_id`** — an arbitrary, unique string. It appears in NOTIFY payloads and in the proxy's WebSocket URL (`ws://127.0.0.1:8080/ws/{query_id}`), so keep it short and URL-safe. Conventions: lowercase with underscores (`active_orders`), a scope prefix for multi-tenant apps (`org_123_orders`).

**`p_query`** — the `SELECT` to watch. Any standard `SELECT` works, including joins, aggregates, `GROUP BY`, window functions, and `HAVING`. See [query support](./query-support.md) for the full surface and its limits.

**`p_mode`** — `'delta'` (default) or `'notify'`. The two modes are detailed below.

**`p_audience`** — an optional JSON object the Go proxy enforces against JWT claims at WebSocket connect time. Every key must byte-match the corresponding claim or the connection is rejected with `403`. `service_role` JWTs always bypass. `NULL` (the default) is public — any authenticated client may read. Max 512 bytes serialised. See [the security model](./security-model.md) for the audience pattern in full.

### delta vs notify

| | `delta` (default) | `notify` |
|---|---|---|
| What arrives | `{"query_id","seq","inserted":[...],"deleted":[...]}` — the exact changed rows | `{"type":"invalidated","query_id","seq"}` — a bare "something changed" signal |
| Snapshot kept | Yes (`pgr._snap_<id>`), so the diff can be computed | No diff computed; the snapshot is not consulted |
| Client work | Apply the rows directly to local state | Re-fetch the full query result on its own schedule |
| Pick it when | You want the UI to update from the wire with no extra round-trip | The result is large/expensive to diff, or the client would re-fetch anyway (e.g. paginated views, cache busting) |

```sql
-- delta: the client receives exact insert/delete rows
SELECT pgr.subscribe(
  'active_orders',
  $$SELECT id, customer_id, status, amount
    FROM orders
    WHERE status IN ('pending', 'processing')$$
);

-- notify: the client only learns the set changed, then re-fetches
SELECT pgr.subscribe(
  'feed_dirty',
  $$SELECT id FROM feed_items WHERE published$$,
  'notify'
);
```

What lands on the channel for each mode — including the `seq` counter and overflow rules — is documented in [wire format](./wire-format.md).

### Column-level tracking

`pgr.subscribe` records exactly which columns your query references. An `UPDATE` that touches only unreferenced columns does **no** recompute work — the per-query UPDATE trigger does not even fire.

```sql
SELECT pgr.subscribe('order_totals', 'SELECT id, status, amount FROM orders');
-- UPDATE orders SET notes  = '...'  → no recompute (notes is not referenced)
-- UPDATE orders SET status = 'shipped' → recompute + delta
```

---

## pgr.unsubscribe

```sql
pgr.unsubscribe(p_query_id text) RETURNS boolean
```

Remove a subscription: drops its snapshot table, removes the per-query triggers from the watched tables, deletes its shared-memory slot, and deletes its `pgr.persisted_subscriptions` row. Returns `true` if a subscription was removed, `false` if none existed under that id — so it is always safe to call.

```sql
SELECT pgr.unsubscribe('active_orders');   -- → true
SELECT pgr.unsubscribe('never_existed');   -- → false (no-op)
```

### The idempotent-setup pattern

Because `unsubscribe` is a safe no-op, call it before every `subscribe` in setup scripts so a re-run cleans up the previous registration instead of erroring:

```sql
SELECT pgr.unsubscribe('active_orders');
SELECT pgr.subscribe(
  'active_orders',
  $$SELECT id, customer_id, status, amount
    FROM orders WHERE status = 'pending'$$
);
```

This makes seed/setup files re-runnable. (The pattern matters for hand-written setup scripts; production registration usually lives behind a `SECURITY DEFINER` wrapper — see below.)

---

## pgr.get_subscriptions

```sql
pgr.get_subscriptions()
  RETURNS SETOF record(query_id, query_text, num_tables,
                       subscribed_at, invalidation_count, mode, audience)
```

List the subscriptions currently live in shared memory.

```sql
SELECT * FROM pgr.get_subscriptions();
```

| query_id | query_text | num_tables | subscribed_at | invalidation_count | mode | audience |
|----------|-----------|-----------:|---------------|-------------------:|------|----------|
| active_orders | SELECT id, ... | 1 | 2026-06-11 12:00:00+00 | 0 | delta | NULL |
| inv_42 | SELECT name, ... | 1 | 2026-06-11 12:01:00+00 | 3 | delta | `{"sub":"42"}` |

This reflects in-memory state only. After a restart the list is empty until you run `pgr.restore_subscriptions()`.

---

## pgr.restore_subscriptions

```sql
pgr.restore_subscriptions() RETURNS int   -- count restored
```

Subscriptions live in shared memory, and their snapshot tables are `UNLOGGED` — both vanish on any PostgreSQL restart or crash. The durable record lives in the LOGGED catalog `pgr.persisted_subscriptions`, which `pgr.subscribe`/`pgr.unsubscribe` maintain transparently. `restore_subscriptions()` replays that catalog back into shared memory and rebuilds the snapshots:

```sql
SELECT pgr.restore_subscriptions();   -- → number of subscriptions restored
```

It is idempotent — already-active subscriptions are skipped — and per-subscription failures (for example, a watched table was dropped) become a `WARNING` without aborting the rest. `EXECUTE` is revoked from `PUBLIC`; run it as a privileged role.

Call it **once per database** after a restart, before clients reconnect. The all-in-one Docker image runs it automatically at boot for every database with the extension installed; on self-managed deployments, wire it into your startup/post-init hook. Until it runs, restored queries emit no deltas even though clients can connect.

---

## pgr.stats

```sql
pgr.stats() RETURNS SETOF (metric text, value text)
```

Extension-wide counters, accumulated over the server's lifetime (they are **not** reset by unsubscribe and persist until the next restart):

```sql
SELECT * FROM pgr.stats();
```

| metric | meaning |
|--------|---------|
| `active_subscriptions` | live subscriptions right now |
| `max_subscriptions` | the `pg_reactive.max_subscriptions` slot ceiling |
| `total_subscribes` | lifetime `subscribe` calls |
| `total_unsubscribes` | lifetime `unsubscribe` calls |
| `total_invalidations` | lifetime trigger fires that produced a notification |
| `total_evictions` | LRU evictions (subscriptions dropped because the slot table was full) |
| `total_recomputes` | lifetime snapshot recomputations |

A climbing `total_evictions` means you have more concurrently-active queries than `pg_reactive.max_subscriptions` slots — raise that GUC (see [GUCs](./gucs.md)).

---

## Full lifecycle example

Drive the whole thing from `psql`. Any client that can `LISTEN pgr` (psql, libpq, pgx, asyncpg, the `pg` Node driver, JDBC) sees the same stream.

```sql
-- 0. The extension must be installed (see ./install.md).
CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS orders (
  id          serial PRIMARY KEY,
  customer_id int  NOT NULL,
  status      text NOT NULL,
  amount      numeric NOT NULL
);

-- 1. Subscribe (idempotent setup pattern).
SELECT pgr.unsubscribe('orders_active');
SELECT pgr.subscribe(
  'orders_active',
  $$SELECT id, customer_id, status, amount
    FROM orders WHERE status IN ('open', 'pending')$$
);

-- 2. Listen on the single notify channel.
LISTEN pgr;

-- 3. A matching INSERT produces a delta.
INSERT INTO orders (customer_id, status, amount) VALUES (42, 'open', 99.99);
-- Asynchronous notification "pgr" received:
-- {"query_id":"orders_active","seq":1,
--  "inserted":[{"id":1,"customer_id":42,"status":"open","amount":99.99}],
--  "deleted":[]}

-- 4. An UPDATE that moves a row out of the result set appears as a delete.
UPDATE orders SET status = 'shipped' WHERE id = 1;
-- {"query_id":"orders_active","seq":2,
--  "inserted":[],
--  "deleted":[{"id":1,"customer_id":42,"status":"open","amount":99.99}]}

-- 5. Inspect and tear down.
SELECT * FROM pgr.get_subscriptions();
SELECT pgr.unsubscribe('orders_active');   -- → true
```

In `psql`, run `LISTEN pgr;` then issue the DML in the same session — the asynchronous notifications print between commands. To see the same stream over WebSocket instead, point a client at `ws://127.0.0.1:8080/ws/orders_active` (see [the proxy](./proxy.md) and [the SDK](./sdk.md)).

---

## Production registration: SECURITY DEFINER wrappers

Do not grant `pgr.subscribe` to application roles. Instead, expose **one wrapper per query shape**, with a fixed query template and a server-derived `query_id` and audience. This is the canonical pattern — here it is from `examples/apps/todo/setup.sql`:

```sql
-- SECURITY DEFINER + pinned search_path: pg_catalog + pg_temp only,
-- every app object fully qualified (public.todos, pgr.subscribe, auth.uid).
CREATE OR REPLACE FUNCTION public.subscribe_my_todos()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_qid text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;
  v_qid := 'todos_' || v_uid::text;
  PERFORM pgr.subscribe(
    v_qid,
    format('SELECT id, text, priority, done, due_at, created_at
            FROM public.todos WHERE user_id = %L
            ORDER BY done ASC, priority DESC, created_at DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );
  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_todos() TO authenticated;
```

The application role gets `EXECUTE` on `public.subscribe_my_todos()`, never on `pgr.subscribe`. The query text is a constant the caller cannot influence; only the `user_id` is derived (server-side, from the JWT) and pinned into both the `WHERE` clause and the audience. See [the security model](./security-model.md) for why each clause — pinned `search_path`, fully-qualified references, explicit `GRANT` — is load-bearing.

---

## Subscription limits

The number of simultaneous subscriptions is capped by the `pg_reactive.max_subscriptions` shared-memory slot count (default `1024`, set at server start). When the table is full, the least-recently-subscribed query is evicted via LRU and its `total_evictions` counter ticks. Raising the ceiling requires a restart — see [GUCs](./gucs.md).

## Where deltas go next

Once a subscription is producing notifications, the [wire format](./wire-format.md) page documents every message shape on the `pgr` channel, the `seq` counter, and overflow handling. To fan those deltas out to browsers, see [the proxy](./proxy.md), [the SDK](./sdk.md), and [the React bindings](./react.md). For a backend-stack-in-a-box that bundles all of this, pgStack is the batteries-included umbrella — start at its [quickstart](/quickstart).
