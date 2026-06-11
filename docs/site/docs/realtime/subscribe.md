---
title: Subscribing to Queries
sidebar_position: 2
description: Register live queries with pgr.subscribe() and manage subscriptions.
---

# Subscribing to Queries

Live queries are registered in PostgreSQL using the `pgr.subscribe()` function. Once registered, any change to the underlying tables triggers an automatic diff and delta delivery.

## Register a live query

```sql
SELECT pgr.subscribe(
  'query_id',   -- unique string identifier
  'SELECT ...'  -- the SQL query to watch
);
```

### Examples

```sql
-- Active orders
SELECT pgr.subscribe(
  'active_orders',
  'SELECT id, customer_id, status, amount, created_at
   FROM orders
   WHERE status IN (''pending'', ''processing'')
   ORDER BY created_at DESC'
);

-- User's notifications (parametric via a session variable)
SELECT pgr.subscribe(
  'user_notifications',
  'SELECT id, type, message, created_at
   FROM notifications
   WHERE user_id = (current_setting(''app.user_id'', true))::uuid
     AND read = false
   ORDER BY created_at DESC'
);

-- Dashboard summary (aggregate)
SELECT pgr.subscribe(
  'order_summary',
  'SELECT
     count(*) FILTER (WHERE status = ''pending'')  AS pending_count,
     count(*) FILTER (WHERE status = ''shipped'')  AS shipped_count,
     sum(amount) FILTER (WHERE created_at >= current_date) AS revenue_today
   FROM orders'
);

-- Cross-table join
SELECT pgr.subscribe(
  'order_details',
  'SELECT o.id, o.status, o.amount, c.name AS customer_name, c.email
   FROM orders o
   JOIN customers c ON c.id = o.customer_id
   WHERE o.status != ''cancelled'''
);
```

## Query ID conventions

The query ID is an arbitrary string. Conventions:
- Use lowercase with underscores: `active_orders`, `user_notifications`
- Include a scope prefix for multi-tenant apps: `org_123_orders`
- Keep it short — it appears in WebSocket URLs and NOTIFY payloads

## List active subscriptions

```sql
SELECT * FROM pgr.get_subscriptions();
```

Returns:

| query_id | query_text | num_tables | subscribed_at | invalidation_count | mode | audience |
|----------|------------|------------|---------------|--------------------|------|----------|
| active_orders | SELECT id, ... | 1 | 2025-01-14 12:00:00+00 | 0 | delta | NULL |
| user_notifications | SELECT id, ... | 1 | 2025-01-14 12:01:00+00 | 3 | delta | NULL |

## Unsubscribe

```sql
SELECT pgr.unsubscribe('active_orders');
```

This removes the subscription, drops the snapshot table, and removes the trigger from watched tables.

## Audience-bound subscriptions (since 0.1.2)

`pgr.subscribe` takes an optional fourth `audience` argument — a JSON object the proxy enforces against the JWT claims at WS-connect time. Every key in the audience must match the corresponding claim, or the connection is rejected with `403 Forbidden`. `service_role` JWTs always bypass.

This is the right pattern for **per-user live queries** (player inventory, private notifications, account-scoped views): even if a malicious client learns or guesses another user's `query_id`, their JWT will not satisfy that subscription's audience.

```sql
-- Server registers per-player subscription at login.
-- The audience binds the subscription to the player's JWT sub claim.
SELECT pgr.subscribe(
  'inv_' || player_id::text,
  format(
    'SELECT name, count FROM player_inventory WHERE player_id = %L',
    player_id),
  'delta',
  jsonb_build_object('sub', player_id::text));
```

Client (with JWT where `sub=42`):

```ts
const live = client.subscribe('inv_42');  // OK — JWT.sub matches audience.sub
```

Other clients (with `sub=99`) attempting the same URL get `403 Forbidden` before any data is delivered.

### Audience semantics

- `NULL` audience (default) = public; any authenticated WS client can read.
- JSON object = strict AND-match: every key must be present in claims with byte-equal value.
- `{"sub":"42"}` matches `{"sub":"42",...}` but **not** `{"sub":42,...}` — pick a consistent JWT encoding.
- Max 511 bytes serialised.
- Combine with [REQUIRE_AUTHENTICATED_WS](../deploy/env-vars.md) for defence in depth: even public subscriptions then require a JWT.

### Capability vs audience

The older capability-via-unguessable-id pattern (server-side broker hands out random `channel_id`) still works and is appropriate for short-lived or rotating channels. Audience is the right choice when:
- The subscription is long-lived and tied to a stable user identity.
- You want a leaked channel name to be useless without the matching JWT.
- You want server-side audit of "who is bound to what" in terms of claims, not opaque ids.

## Surviving restarts (since 0.1.4)

Subscriptions live in shared memory, which is wiped on a PostgreSQL restart. Since 0.1.4, `pgr.subscribe()` also records each subscription (query, mode, audience, owner role) in the logged catalog table `pgr.persisted_subscriptions`, and `pgr.unsubscribe()` removes it.

After a restart, replay the catalog into shared memory:

```sql
SELECT pgr.restore_subscriptions();
-- returns the number of subscriptions restored
```

The function is idempotent — already-active subscriptions are skipped, and a subscription that fails to restore (for example, its table was dropped) raises a warning without aborting the rest. The all-in-one Docker image runs it automatically at boot for every database with the extension installed; on self-managed deployments, call it once from your startup hook before clients reconnect. `EXECUTE` is revoked from `PUBLIC` — run it as a privileged role.

## Subscription limits

The maximum number of simultaneous subscriptions is controlled by:

```
pg_reactive.max_subscriptions = 1024  (default)
```

This is a shared memory limit set at PostgreSQL startup. To change it, update your `docker-compose.yml` command flag and restart:

```yaml
command: >
  postgres
    -c shared_preload_libraries=pg_reactive
    -c pg_reactive.max_subscriptions=4096
```

## How triggers work

When you call `pgr.subscribe()`, pg_reactive:

1. Parses your SQL to extract the referenced table OIDs
2. Creates or reuses AFTER STATEMENT triggers on each referenced table
3. Creates an UNLOGGED snapshot table `pgr._snap_<query_id>`
4. Runs your query immediately to populate the initial snapshot

When a watched table changes:

1. The AFTER STATEMENT trigger fires
2. pg_reactive executes your query into a temporary table
3. Computes `(new_result EXCEPT old_snapshot) UNION ALL (old_snapshot EXCEPT new_result)`
4. If the diff is non-empty, publishes a NOTIFY on the `pgr` channel
5. Updates the snapshot table

## Column-level tracking

pg_reactive tracks which columns your query references. For UPDATE operations, it only re-runs the snapshot computation if an updated column appears in your query. This reduces unnecessary recomputation.

```sql
-- This query only references id, status, amount
SELECT pgr.subscribe(
  'order_totals',
  'SELECT id, status, amount FROM orders'
);

-- An UPDATE to orders.notes will NOT trigger recomputation
-- An UPDATE to orders.status WILL trigger recomputation
```

## Snapshot visibility note

AFTER STATEMENT triggers fire at the end of each statement, inside the still-open transaction — not after commit. With `pg_reactive.batch_invalidation` (default on), recompute is deferred to a single pass per query at transaction pre-commit, and PostgreSQL delivers the NOTIFY to listeners only at commit — so deltas reflect the transaction's final committed state, never intermediate states.

## Server-side subscription management

For server-side applications (Next.js API routes, Express, etc.), use the `PgReactiveAdmin` class to manage subscriptions programmatically:

```typescript
import { PgReactiveAdmin } from '@pgstack/sdk/server';

const admin = new PgReactiveAdmin({
  connectionString: process.env.DATABASE_URL!,
});

// Register
await admin.register(
  'active_orders',
  "SELECT id, status, amount FROM orders WHERE status = 'active'",
);

// List subscriptions
const subs = await admin.listSubscriptions();

// Unregister
await admin.unregister('active_orders');

// Cleanup
await admin.close();
```
