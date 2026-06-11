---
title: pgstack init
sidebar_position: 2
description: Scaffold a new pgStack project with docker-compose.yml, .env, and migrations.
---

# pgstack init

Scaffold a new pgStack project directory.

## Usage

```bash
npx pgstack init <project-name>
```

## What gets created

```
<project-name>/
├── docker-compose.yml           # Development stack
├── .env                         # Auto-generated secrets (JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY)
├── .env.example                 # Placeholder template for production
├── pgstack.config.json          # Project config (ports, pg version, schemas)
├── .gitignore                   # Ignores .env, node_modules, generated types
├── seed.sql                     # Seed data (npx pgstack db seed)
├── public/
│   └── index.html               # Starter page served by the proxy
├── types/                       # Output dir for generated TypeScript types
└── migrations/
    └── 00000000000000_pgstack_init.sql  # pgStack bootstrap (roles, auth, RLS backbone)
```

## Example

```bash
npx pgstack init my-app
cd my-app

# .env was generated with unique random secrets (JWT_SECRET, ANON_KEY,
# SERVICE_ROLE_KEY) — review it. Do NOT copy .env.example over it:
# the example file contains <openssl rand -base64 32> placeholders only.

# Start the dev stack
npx pgstack dev
```

## Generated docker-compose.yml

The generated file starts two containers:

```yaml
services:
  db:
    # PostgreSQL 16 + pg_reactive extension
    image: ghcr.io/ndokutovich/pgstack-postgres:latest
    ...

  proxy:
    # pgStack proxy (auth, REST, WebSockets)
    image: ghcr.io/ndokutovich/pgstack-proxy:latest
    ...
```

In development it uses pre-built images. For a source build (with your own modifications), use the full repository.

## Generated bootstrap migration

`migrations/00000000000000_pgstack_init.sql` is written verbatim from
`cli/templates/bootstrap-core.sql` (itself generated from `docker/init.sql`,
the schema source of truth). It contains the security backbone:

- roles `anon`, `authenticated`, `service_role`
- `pgstack.users`, `pgstack.refresh_tokens`, `pgstack.email_tokens`, storage tables
- `auth.uid()` / `auth.role()` / `auth.email()` / `auth.jwt()` helpers
- Row Level Security policies and default-deny grants
- function-execute revoke (no `PUBLIC EXECUTE`)

It ends with commented guidance for adding your own tables. No application
tables (such as a todos table) are created for you.

## Adding your own tables

Create a second migration for application schema:

```bash
npx pgstack migration create add_todos
```

Then fill it in, for example:

```sql
-- Example: a simple todos table
CREATE TABLE todos (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES pgstack.users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  done       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- Users can only see their own todos
CREATE POLICY "Users see own todos" ON todos
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users insert own todos" ON todos
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own todos" ON todos
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users delete own todos" ON todos
  FOR DELETE USING (user_id = auth.uid());

-- Grant table access to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO authenticated;
```

## Options

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Parent directory to create the project in (default `.`) |

## After initialization

1. Review `.env` — `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY` are auto-generated; change `POSTGRES_PASSWORD` (defaults to `postgres`) before exposing the stack
2. Run `npx pgstack dev` to start the containers
3. Run `npx pgstack migration run` to apply migrations
4. Install the SDK: `npm install @pgstack/sdk`
