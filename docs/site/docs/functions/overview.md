---
title: Overview
sidebar_position: 1
description: Run server-side code with pgStack Edge Functions — Deno, PL/v8, or embedded JS.
---

# Edge Functions

Edge Functions let you run server-side code triggered by HTTP requests. Unlike RPC (which runs SQL functions inside PostgreSQL), Edge Functions can call external APIs, process webhooks, and run business logic in JavaScript/TypeScript.

## Three runtime backends

pgStack supports three runtimes, choosable per function:

| Runtime | Language | External APIs | Runs in | Best for |
|---------|----------|--------------|---------|----------|
| **Deno** | TypeScript/JS | Yes (full `fetch`) | Sidecar container | Full-featured functions, npm packages |
| **PL/v8** | JavaScript | No | Inside PostgreSQL | ACID transactions, data-heavy logic |
| **Embedded** | JavaScript | Limited | Go proxy process | Simple transforms, webhooks, lightweight handlers |

## Quick start

### 1. Scaffold a function

```bash
pgstack functions new hello
```

Creates `supabase/functions/hello/index.ts`:

```typescript
Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));

  return new Response(
    JSON.stringify({ message: "Hello from hello!" }),
    { headers: { "Content-Type": "application/json" } },
  );
});
```

### 2. Deploy it

```bash
pgstack functions deploy hello --runtime deno
```

### 3. Invoke it

```bash
curl -X POST http://127.0.0.1:8080/functions/v1/hello \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "world"}'
```

### SDK usage

```typescript
const { data, error } = await client.functions.invoke('hello', {
  body: { name: 'world' },
});
// data.message === "Hello from hello!"
```

## Authentication

By default, functions require a valid JWT (`verify_jwt: true`). Anonymous callers get a 401. Deploy with `--no-verify-jwt` to allow unauthenticated access.

Functions receive the caller's identity via auth headers:
- `x-pgstack-role` — `anon`, `authenticated`, or `service_role`
- `x-pgstack-claims` — Full JWT claims JSON
- `x-pgstack-sub` — User ID (UUID)

## Security

### RLS enforcement

The embedded JS runtime (goja) enforces Row Level Security on all database queries. Each `db.query()` call runs inside a transaction with `SET LOCAL ROLE` matching the caller's JWT claims. This means embedded functions respect the same RLS policies as REST API requests.

Roles are whitelisted (`anon`, `authenticated`); embedded functions cannot escalate to `service_role`. An execution timeout prevents infinite loops from blocking the proxy.

### Body size limit

Edge Function requests are subject to the `MAX_BODY_SIZE` limit (default 1 MB) to prevent resource exhaustion.

## API reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/functions/v1/{name}` | POST | JWT or anon | Invoke a function |
| `/functions/v1/{name}` | GET | JWT or anon | Invoke a function (GET) |
| `/functions/v1/` | GET | service_role | List all functions |
| `/functions/v1/_refresh` | POST | service_role | Reload function catalog |
