---
title: REST API Overview
sidebar_position: 1
description: pgStack REST API — PostgREST-compatible CRUD, filters, embedding, and RPC.
---

# REST API Overview

pgStack exposes a PostgREST-compatible REST API at `/rest/v1/`. Any table or view in your PostgreSQL database (that the authenticated role has access to) is queryable via HTTP.

## Base URL

```
http://127.0.0.1:8080/rest/v1/
```

## Authentication

Every request must include an `Authorization` header:

```
Authorization: Bearer <token>
```

Where `<token>` is:
- Your **anon key** (`ANON_KEY`) for unauthenticated/public requests
- A **JWT access token** (from login) for authenticated user requests
- Your **service role key** (`SERVICE_ROLE_KEY`) for admin requests that bypass RLS

## SDK usage

The TypeScript SDK wraps the REST API with a fluent query builder:

```typescript
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

// After login, the SDK automatically uses the user's access token
await pgstack.auth.signInWithPassword({ email: '...', password: '...' });

// SELECT
const { data, error } = await pgstack.from('todos')
  .select('*')
  .eq('done', false)
  .order('created_at', { ascending: false })
  .limit(20);

// INSERT
const { data, error } = await pgstack.from('todos')
  .insert({ title: 'Buy groceries', done: false });

// UPDATE
const { data, error } = await pgstack.from('todos')
  .update({ done: true })
  .eq('id', 42);

// DELETE
const { data, error } = await pgstack.from('todos')
  .delete()
  .eq('id', 42);
```

## CRUD operations

### SELECT

```bash
GET /rest/v1/todos
GET /rest/v1/todos?select=id,title,done
GET /rest/v1/todos?done=eq.false&order=created_at.desc&limit=20
```

### INSERT

```bash
POST /rest/v1/todos
Content-Type: application/json

{"title": "Buy groceries", "done": false}
```

Insert multiple rows by sending an array:

```bash
POST /rest/v1/todos
Content-Type: application/json

[
  {"title": "Buy groceries"},
  {"title": "Walk the dog"},
  {"title": "Pay bills"}
]
```

### UPDATE

```bash
PATCH /rest/v1/todos?id=eq.42
Content-Type: application/json

{"done": true}
```

### UPSERT

```bash
POST /rest/v1/todos?on_conflict=id
Prefer: resolution=merge-duplicates
Content-Type: application/json

{"id": 42, "title": "Updated title", "done": true}
```

### DELETE

```bash
DELETE /rest/v1/todos?id=eq.42
```

## Response format

Successful responses return a JSON array for SELECT, or the modified rows for INSERT/UPDATE/DELETE:

```json
[
  {"id": 1, "title": "Buy groceries", "done": false, "created_at": "2025-01-01T00:00:00Z"},
  {"id": 2, "title": "Walk the dog", "done": true, "created_at": "2025-01-01T01:00:00Z"}
]
```

Error responses:

```json
{"error": "relation \"nonexistent\" does not exist", "status": 400}
```

## Vertical filtering (select columns)

Return only specific columns:

```bash
GET /rest/v1/todos?select=id,title
```

With embedding (FK joins):

```bash
GET /rest/v1/orders?select=id,status,customers(name,email)
```

## TypeScript types

Generate TypeScript types from your database schema with the CLI:

```bash
npx pgstack generate types --output src/types/database.ts
```

Then use them with the query builder:

```typescript
import type { Database } from './types/database';

type Todo = Database['public']['Tables']['todos']['Row'];

const { data } = await pgstack.from<Todo>('todos').select('*');
// data is Todo[] | null — fully typed
```

## Next steps

- [Filters](./filters) — all filter operators with examples
- [Embedding](./embedding) — fetch related rows via foreign keys
- [RPC](./rpc) — call PostgreSQL functions
- [Pagination](./pagination) — cursor and offset pagination
