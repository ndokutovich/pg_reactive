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

| query_id | sql | subscribed_at |
|----------|-----|---------------|
| active_orders | SELECT id, ... | 2025-01-14 12:00:00+00 |
| user_notifications | SELECT id, ... | 2025-01-14 12:01:00+00 |

## Unsubscribe

```sql
SELECT pgr.unsubscribe('active_orders');
```

This removes the subscription, drops the snapshot table, and removes the trigger from watched tables.

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
3. Creates an UNLOGGED snapshot table `pgr._snapshot_<query_id>`
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

AFTER STATEMENT triggers run after the DML commits. The trigger can see the committed state of the data, so deltas always reflect the final state — not intermediate states within a transaction.

## Server-side subscription management

For server-side applications (Next.js API routes, Express, etc.), use the `PgReactiveAdmin` class to manage subscriptions programmatically:

```typescript
import { PgReactiveAdmin } from '@pgstack/sdk/server';

const admin = new PgReactiveAdmin({
  connectionString: process.env.DATABASE_URL!,
});

// Subscribe
await admin.subscribe(
  'active_orders',
  "SELECT id, status, amount FROM orders WHERE status = 'active'",
);

// List subscriptions
const subs = await admin.getSubscriptions();

// Unsubscribe
await admin.unsubscribe('active_orders');

// Cleanup
await admin.end();
```
