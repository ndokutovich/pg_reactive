---
title: What is pgStack?
sidebar_position: 1
description: pgStack is a PostgreSQL-native backend platform — a self-hosted Supabase alternative running in two Docker containers.
---

# What is pgStack?

pgStack is an open-source PostgreSQL-native backend platform — a self-hosted alternative to Supabase that runs in **two Docker containers** instead of 15+.

Everything you expect from a modern backend: authentication, a REST API, real-time subscriptions, an admin Studio, a CLI, and a TypeScript SDK — all powered by PostgreSQL, with no extra services.

## The stack

| Component | Technology | What it does |
|-----------|-----------|--------------|
| Database | PostgreSQL 16 + pg_reactive | Live queries, auth schema, your data |
| Proxy | Rust (axum) | Auth, REST API, WebSockets, OAuth, RLS |
| Studio | React SPA | Admin dashboard at `/studio` |
| SDK | TypeScript | Client library for auth, REST, live queries |
| CLI | Node.js | Scaffold, migrate, generate types |

## Architecture overview

```
Your App (React, Next.js, etc.)
    │
    ▼
pgStack Proxy (Rust / axum)  ← port 8080
  ├── /auth/v1/*      Auth (signup, login, refresh, OAuth)
  ├── /rest/v1/*      REST API (PostgREST-compatible CRUD)
  ├── /ws/:query_id   WebSocket live query subscriptions
  └── /studio/        Admin UI
    │
    ▼
PostgreSQL 16 + pg_reactive extension  ← port 5432 (internal)
  ├── pgstack schema  (users, tokens, sessions, RLS policies)
  ├── pgr schema      (live query subscriptions, snapshots)
  └── your schema     (your tables, your data)
```

## Philosophy

**Zero extra services.** Redis, GoTrue, Realtime — all eliminated. PostgreSQL is the only stateful component. Sessions are rows, job queues are tables, pub/sub is `LISTEN`/`NOTIFY`.

**PostgREST-compatible REST API.** The filter syntax, embedding syntax, and response format match PostgREST. If you're migrating from Supabase, most client code works without changes.

**Real-time first.** The `pg_reactive` C extension turns any `SELECT` into a live query. Changes are diffed at the SQL layer using `EXCEPT`-based comparison and delivered as JSON deltas over WebSocket.

**RLS enforced by default.** Every REST request runs as the authenticated PostgreSQL role. The proxy sets `request.jwt.claims` and switches role before executing queries, so your `ROW LEVEL SECURITY` policies run automatically.

**Two containers.** `docker compose up -d` and you're done. No Kubernetes required for development or small production deployments.

## Quick example

```bash
# Start everything
docker compose up -d

# Sign up
curl -X POST http://127.0.0.1:8080/auth/v1/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"hello@example.com","password":"strongpassword"}'

# Query your data
curl http://127.0.0.1:8080/rest/v1/todos?done=eq.false \
  -H 'Authorization: Bearer <access_token>'
```

```typescript
// TypeScript client
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

// Auth
const { data } = await pgstack.auth.signInWithPassword({
  email: 'hello@example.com',
  password: 'strongpassword',
});

// REST queries
const { data: todos } = await pgstack.from('todos')
  .select('*')
  .eq('done', false)
  .order('created_at', { ascending: false });

// Live queries (WebSocket)
import { useLiveQuery } from '@pgstack/sdk/react';

function TodoList() {
  const { rows, state } = useLiveQuery('active_todos', {
    url: 'ws://127.0.0.1:8080',
    token: session.access_token,
  });
  return <ul>{rows.map(r => <li key={String(r.id)}>{String(r.title)}</li>)}</ul>;
}
```

## Next steps

- [Quick Start](./quickstart) — up and running in 5 minutes
- [Installation](./installation) — full installation options
- [vs Supabase](./vs-supabase) — feature comparison
