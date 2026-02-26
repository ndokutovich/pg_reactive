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
- View table structure (columns, types, constraints)
- Browse row data with pagination
- Insert, update, and delete rows via UI
- Filter rows by column values
- Export data as CSV or JSON

### SQL Editor

Run arbitrary SQL queries:
- Multi-line SQL editor with syntax highlighting
- Query history
- Results displayed as a table
- Export query results
- Useful for migrations, debugging, and ad-hoc queries

### Auth Users

Manage users registered through the auth system:
- List all users with email, role, created date
- View user metadata
- Manually create users
- Delete users
- Reset passwords (issues a new password hash)

### Database Browser

Explore your PostgreSQL schema:
- List all schemas, tables, views, functions
- View table DDL (CREATE TABLE statements)
- View indexes, constraints, and foreign keys
- Inspect the pgStack system schema (`pgstack.*`)
- Inspect the pg_reactive schema (`pgr.*`)

### Realtime Monitor

Monitor live query subscriptions:
- List all active subscriptions with their SQL
- View subscription statistics (last delta time, snapshot size)
- Manually trigger a recompute
- Unsubscribe queries

### Logs

View proxy request logs:
- HTTP request log (method, path, status, latency)
- Auth events (signup, login, logout)
- WebSocket connection events
- Error log

## Security

Studio is served at `/studio/` and protected by the `SERVICE_ROLE_KEY`. Do not expose port 8080 directly to the public internet in production.

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

To disable Studio in production, set the `ENABLE_STUDIO` environment variable to `false`:

```env
ENABLE_STUDIO=false
```

The `/studio/` path will return 404.
