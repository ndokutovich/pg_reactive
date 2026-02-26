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
├── docker-compose.yml           # Development stack (builds from source)
├── docker-compose.prod.yml      # Production stack (pre-built images)
├── .env.example                 # All environment variables with descriptions
├── .gitignore                   # Ignores .env and node_modules
├── package.json                 # pgstack CLI as dev dependency
└── migrations/
    └── 00001_init.sql           # Starter migration (creates a todos table)
```

## Example

```bash
npx pgstack init my-app
cd my-app

# Configure your environment
cp .env.example .env
# Edit .env with your secrets (JWT_SECRET, passwords, etc.)

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

## Generated starter migration

The `migrations/00001_init.sql` gives you a working starting point:

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
| `--template <name>` | Use a specific project template (planned) |

## After initialization

1. Configure `.env` (especially `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD`)
2. Run `npx pgstack dev` to start the containers
3. Run `npx pgstack migration up` to apply migrations
4. Install the SDK: `npm install @pgstack/sdk`
