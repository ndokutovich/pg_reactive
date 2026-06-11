---
title: SQL Editor
sidebar_position: 3
description: Run SQL queries directly against your PostgreSQL database from pgStack Studio.
---

# SQL Editor

The SQL Editor lets you run arbitrary SQL queries against your PostgreSQL database from the browser.

## Opening the SQL Editor

1. Open Studio at [http://127.0.0.1:8080/studio/](http://127.0.0.1:8080/studio/)
2. Click **SQL Editor** in the left sidebar

## Writing and running queries

Type SQL into the editor and press **Run** (or Ctrl+Enter / Cmd+Enter):

```sql
SELECT id, email, created_at
FROM pgstack.users
ORDER BY created_at DESC
LIMIT 10;
```

The results appear below the editor as a table.

## Multi-statement queries

The SQL editor runs the entire contents of the editor as a single query. For multiple statements, use a transaction:

```sql
BEGIN;
INSERT INTO categories (name) VALUES ('Electronics');
INSERT INTO products (name, category_id, price)
VALUES ('Laptop', currval('categories_id_seq'), 999.99);
COMMIT;
```

## Example queries

### Check pg_reactive subscriptions

```sql
SELECT query_id, subscribed_at
FROM pgr.get_subscriptions();
```

### View auth users

```sql
SELECT id, email, role, created_at, raw_user_meta
FROM pgstack.users
ORDER BY created_at DESC;
```

### Count rows per table

```sql
SELECT
  schemaname,
  tablename,
  n_live_tup AS estimated_row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

### Show active connections

```sql
SELECT pid, usename, application_name, state, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY state;
```

### Check index usage

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan AS scans,
  idx_tup_read AS rows_read
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### Manage live queries

```sql
-- Register a live query
SELECT pgr.subscribe(
  'recent_orders',
  'SELECT id, status, amount FROM orders ORDER BY created_at DESC LIMIT 100'
);

-- List subscriptions
SELECT * FROM pgr.get_subscriptions();

-- Remove a subscription
SELECT pgr.unsubscribe('recent_orders');
```

### Run migrations manually

```sql
ALTER TABLE products ADD COLUMN weight_grams INTEGER;
ALTER TABLE products ALTER COLUMN description SET NOT NULL;
CREATE INDEX idx_products_category ON products(category_id);
```

## Query history

The SQL editor keeps a history of your recent queries. Click the **History** button to see and re-run past queries.

## Limitations

- The SQL endpoint is mounted only when the proxy runs with `ENABLE_SQL_ENDPOINT=true` (the dev `docker-compose.yml` sets it; default is `false`). With `PGSTACK_ENV=production` the proxy refuses to start with the flag enabled, so the SQL Editor is unavailable in production — without the flag, queries fail with 404.
- Studio's SQL endpoint uses the `SERVICE_ROLE_KEY` — it bypasses RLS. Be careful with destructive queries.
- Bare `SELECT`/`WITH` statements run inside a `READ ONLY` transaction unless they reference `pgr.` functions; other statements run read-write.
- Very long-running queries (> 60 seconds by default) will time out — the bound is the proxy's HTTP `WRITE_TIMEOUT` (no PostgreSQL `statement_timeout` is set).
- The editor is intended for development and debugging. Use migrations for schema changes in production.
