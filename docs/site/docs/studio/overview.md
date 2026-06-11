---
title: Studio Overview
sidebar_position: 1
description: pgStack Studio — the admin dashboard for managing your database, users, and live queries.
---

# Studio Overview

pgStack Studio is a web-based admin dashboard served by the proxy at `/studio/`. It gives you a visual interface for managing your database tables, running SQL, viewing auth users, and monitoring live query subscriptions.

## Accessing Studio

Open [http://127.0.0.1:8080/studio/](http://127.0.0.1:8080/studio/) in your browser.

You will be prompted for a connection key. Enter your `SERVICE_ROLE_KEY` (from `.env`). In development, the default is:

```
dev-only-service-role-key-do-not-use-in-production
```

The service role key bypasses Row Level Security, giving Studio full access to all tables.

## Sections

### Table Editor

Browse and edit your database tables:
- Column names, types, PK and nullable flags shown in the insert/edit row form (full structure browsing lives in the Database Browser)
- Browse row data with pagination
- Insert, update, and delete rows via UI
- Filter rows by column values

### SQL Editor

Run arbitrary SQL queries:
- Multi-line SQL editor with syntax highlighting
- Query history
- Results displayed as a table
- Row count and execution time shown per query
- Useful for migrations, debugging, and ad-hoc queries

### Auth Users

Manage users registered through the auth system:
- List all users with email, role, created date
- View user metadata
- Manually create users
- Delete users
- List and revoke sessions (refresh tokens)

### Database Browser

Explore your PostgreSQL schema:
- List all schemas, tables, views, and materialized views
- View column definitions (types, defaults, nullability, primary keys)
- View indexes, constraints, and foreign keys
- Inspect the pgStack system schema (`pgstack.*`)
- Inspect the pg_reactive schema (`pgr.*`)

### Realtime Monitor

Monitor live query subscriptions:
- List all active subscriptions with their SQL
- View subscription statistics (table count, mode, invalidation count with a live delta-rate sparkline, subscription age)
- To unsubscribe a query, run `SELECT pgr.unsubscribe('<query_id>');` in the SQL Editor

### Logs

Live view of active PostgreSQL queries (`pg_stat_activity`, non-idle backends), refreshed every 3 seconds: backend pid, state, wait events, and the running SQL (last 200 lines kept). Proxy HTTP/auth/WebSocket logs are not shown in Studio — use `docker compose logs proxy` for those.

## Security

Studio is served at `/studio/` and protected by the `SERVICE_ROLE_KEY`. Do not expose port 8080 directly to the public internet in production.

Studio's data features (SQL Editor, Auth Users, Database browser, Realtime monitor, Logs, and the Table Editor's table/column catalog) are backed by `POST /api/sql`, which is mounted only when `ENABLE_SQL_ENDPOINT=true` on the proxy (default `false`; the dev docker-compose sets it). With `PGSTACK_ENV=production` the proxy refuses to start if this flag is enabled, so Studio's SQL-backed pages are non-functional in production deployments by design. The endpoint additionally always requires the service_role key.

In production, put a reverse proxy (nginx, Caddy, Cloudflare) in front of the proxy and add IP-allowlisting or basic auth to the `/studio/` path:

```nginx
# nginx: restrict Studio to internal IPs
location /studio/ {
  allow 10.0.0.0/8;
  allow 192.168.0.0/16;
  deny all;
  proxy_pass http://127.0.0.1:8080;
}

location / {
  proxy_pass http://127.0.0.1:8080;
}
```

## Disabling Studio

There is no on/off flag for Studio. The `/studio/*` routes are always mounted; the handler returns 404 when the directory pointed to by `STUDIO_DIR` (default `/studio`) does not exist. To disable Studio, set `STUDIO_DIR` to a non-existent path (e.g. `STUDIO_DIR=/nonexistent`) or block `/studio/` at your reverse proxy. Note that Studio's SQL-backed pages are already inert in production: `PGSTACK_ENV=production` refuses to start with `ENABLE_SQL_ENDPOINT=true`.
