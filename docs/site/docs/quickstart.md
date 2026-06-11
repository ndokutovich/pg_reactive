---
title: Quick Start
sidebar_position: 2
description: Get pgStack running locally in under 5 minutes.
---

# Quick Start

Get pgStack running locally in under 5 minutes.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js 18+ (for the CLI and SDK)

## Step 1: Create a new project

```bash
npx pgstack init my-app
cd my-app
```

This scaffolds a project with a `docker-compose.yml`, `.env.example`, and an initial migration.

Alternatively, clone the repository directly:

```bash
git clone https://github.com/ndokutovich/pg_reactive.git my-app
cd my-app
cp .env.example .env
```

## Step 2: Start the stack

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** with the `pg_reactive` extension on port `15432` (dev)
- **pgStack Proxy** (auth + REST + WebSockets) on port `8080` (override with `PROXY_PORT` in `.env`)

Wait a few seconds for the database to initialize, then verify everything is healthy:

```bash
docker compose ps
# db and proxy-go should show "healthy" or "running"
# (the cloned repo's compose also starts a legacy Rust reference proxy on 127.0.0.1:8081)
```

## Step 3: Open Studio

Open your browser to [http://127.0.0.1:8080/studio/](http://127.0.0.1:8080/studio/).

Studio is the admin dashboard. Log in with your `SERVICE_ROLE_KEY` (from `.env` — in development the default is `dev-only-service-role-key-do-not-use-in-production`).

From Studio you can:
- Browse and edit tables
- Run SQL queries
- Manage auth users
- Monitor live query subscriptions

## Step 4: Create your first table

In the Studio SQL editor, or via `psql`:

```sql
CREATE TABLE todos (
  id    BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  done  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security (optional for dev, required for prod)
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read todos"
  ON todos FOR SELECT USING (true);

CREATE POLICY "Anyone can insert todos"
  ON todos FOR INSERT WITH CHECK (true);

-- pgStack default-denies table privileges for anon/authenticated
-- (RLS policies alone are not enough — grant what the API needs):
GRANT SELECT, INSERT ON todos TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO anon, authenticated;
```

pgStack's bootstrap intentionally sets no default privileges for `anon`/`authenticated`, so every new table needs explicit GRANTs in addition to RLS policies.

:::note Cloned the repo instead of using `pgstack init`?
The dev image pre-seeds a demo `todos` table (`docker/init.sql`) with a different shape (serial id, no `created_at`) — run `DROP TABLE IF EXISTS todos;` first, otherwise this CREATE fails with `relation "todos" already exists` and the `created_at` ordering in Step 6 errors.
:::

## Step 5: Call the REST API

```bash
# Insert a todo
curl -X POST http://127.0.0.1:8080/rest/v1/todos \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-only-anon-key-do-not-use-in-production' \
  -d '{"title":"Buy groceries"}'

# Read todos
curl http://127.0.0.1:8080/rest/v1/todos \
  -H 'Authorization: Bearer dev-only-anon-key-do-not-use-in-production'
```

## Step 6: Install the SDK

```bash
npm install @pgstack/sdk
```

```typescript
import { createClient } from '@pgstack/sdk/pgstack';

const pgstack = createClient('http://127.0.0.1:8080', 'dev-only-anon-key-do-not-use-in-production');

// Sign up a user
const { data, error } = await pgstack.auth.signUp({
  email: 'user@example.com',
  password: 'strongpassword123',
});

console.log(data?.user); // { id: '...', email: 'user@example.com', ... }

// Query todos
const { data: todos } = await pgstack.from('todos')
  .select('*')
  .eq('done', false)
  .order('created_at', { ascending: false });

console.log(todos); // [{ id: 1, title: 'Buy groceries', done: false, ... }]
```

## Step 7: Subscribe to live updates (optional)

Register a live query in PostgreSQL:

```sql
SELECT pgr.subscribe(
  'active_todos',
  'SELECT * FROM todos WHERE done = false ORDER BY created_at DESC'
);
```

Then subscribe from your client:

```typescript
import { useLiveQuery } from '@pgstack/sdk/react';

function TodoList() {
  const { rows, state } = useLiveQuery('active_todos', {
    url: 'ws://127.0.0.1:8080',
    token: 'dev-only-anon-key-do-not-use-in-production',
  });

  if (state === 'connecting') return <p>Connecting...</p>;

  return (
    <ul>
      {rows.map(row => (
        <li key={String(row.id)}>{String(row.title)}</li>
      ))}
    </ul>
  );
}
```

The dev stack enables JWT auth by default, so the WebSocket upgrade needs a credential — pass the anon key (or a user's `session.access_token`) via `token`. When `REQUIRE_AUTHENTICATED_WS=true`, only real user JWTs are accepted.

Changes to `todos` will be pushed to all connected clients within milliseconds — no polling required.

## What's next?

- [Installation](./installation) — all installation options, environment variables
- [Authentication](./auth/overview) — email/password, OAuth, magic links
- [REST API](./rest/overview) — full query syntax, filters, embedding
- [Transaction Batching](./rest/batch) — multi-operation database transactions
- [Edge Functions](./functions/overview) — server-side code (Deno, PL/v8, embedded)
- [Live Queries](./realtime/overview) — real-time subscriptions
- [CLI Reference](./cli/overview) — migrations, type generation, dev tools
