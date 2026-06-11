---
title: Overview
sidebar_position: 1
description: Run server-side code with pgStack Edge Functions — embedded JS, PL/v8, PL/Python, Deno, or any-language HTTP containers.
---

# Edge Functions

Edge Functions let you run server-side code triggered by HTTP requests. Unlike RPC (which runs SQL functions inside PostgreSQL), Edge Functions can call external APIs, process webhooks, and run business logic in any language.

## Five runtime backends

pgStack supports five runtimes, choosable per function:

| Runtime | Language | External APIs | Runs in | Best for |
|---------|----------|--------------|---------|----------|
| **Embedded** | JavaScript | No | Go proxy process | Simple transforms, webhooks, lightweight handlers |
| **PL/v8** | JavaScript | No | Inside PostgreSQL | ACID transactions, data-heavy logic |
| **PL/Python** | Python 3 | Yes (stdlib; `requests`/`numpy` after pip install in the DB image) | Inside PostgreSQL | ACID transactions, data science, ML inference |
| **Deno** | TypeScript/JS | Yes (full `fetch`) | The single global sidecar container | Full-featured functions, npm packages |
| **HTTP** | **Any** | Yes | A per-function container | Polyglot functions — Go, Rust, Python, Bun, anything that serves HTTP |

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
export SERVICE_ROLE_KEY=<your-service-role-key>   # or pass --service-role-key <key>
pgstack functions deploy hello --runtime deno
```

The `deploy`, `list`, `delete`, and `serve` subcommands authenticate with the service role key: pass `--service-role-key <key>` or set the `SERVICE_ROLE_KEY` environment variable — the command exits with an error if neither is set. Add `--url <url>` if the proxy is not at the default `http://127.0.0.1:8080`.

Deploy registers the function via the proxy's `POST /api/sql` endpoint, which is mounted only when `ENABLE_SQL_ENDPOINT=true` (the dev compose default; forbidden in production). Invoking a `--runtime deno` function returns 503 until `EDGE_RUNTIME_URL` is set — uncomment the `edge-runtime` service and the `EDGE_RUNTIME_URL` line in `docker-compose.yml`.

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

## Local development (hot reload)

Instead of redeploying after every edit, run the watcher. It monitors `supabase/functions/` and re-registers a function whenever its source file changes:

```bash
pgstack functions serve
```

Watched functions are deployed with the runtime given by `--runtime` (default `embedded`). Like the other `functions` subcommands, it needs the service role key (`--service-role-key` or the `SERVICE_ROLE_KEY` env var) and accepts `--url` if the proxy is not at `http://127.0.0.1:8080`.

## Authentication

By default, functions require a valid JWT (`verify_jwt: true`). Anonymous callers get a 401. Deploy with `--no-verify-jwt` to allow unauthenticated access.

Functions receive the caller's identity via auth headers:
- `x-pgstack-role` — `anon`, `authenticated`, or `service_role`
- `x-pgstack-claims` — Full JWT claims JSON
- `x-pgstack-sub` — User ID (UUID)

## Runtime details

### Embedded (goja)

JavaScript via the [goja](https://github.com/dop251/goja) VM, running synchronously inside the Go proxy process. No external dependencies or sidecar containers required. Functions execute in-process with RLS enforcement on all database queries. Best for simple request/response handlers, webhooks, and lightweight transforms.

Embedded code must define a top-level `handler(request)` function and return a JSON-serializable value. `request` carries `body` (parsed JSON), `role`, `sub`, and `claims`; `db.query(sql, ...params)` is the only I/O — there is no `fetch` or network API. Example:

```javascript
function handler(request) {
  const rows = db.query('SELECT * FROM todos WHERE done = $1', false);
  return { role: request.role, count: rows.length, rows };
}
```

The Deno-style scaffold (`Deno.serve(...)`) does not run on this runtime.

### PL/v8

JavaScript inside PostgreSQL via the [PL/v8](https://plv8.github.io/) extension. Functions run with full ACID transaction guarantees and direct SQL access. No network `fetch` is available. Function name convention: `pgstack.fn_{name}(body jsonb) RETURNS jsonb`.

```sql
CREATE OR REPLACE FUNCTION pgstack.fn_hello(body jsonb)
RETURNS jsonb LANGUAGE plv8 AS $$
  var name = body.name || 'world';
  return { message: 'Hello, ' + name + '!' };
$$;
```

### PL/Python (plpython3u)

Python 3 inside PostgreSQL via the [PL/Python](https://www.postgresql.org/docs/current/plpython.html) extension. Functions run with full ACID transaction guarantees and can use Python libraries such as `numpy` and `requests` once pip-installed into the database image (`python3-pip` is preinstalled). Function name convention: `pgstack.fn_{name}(body jsonb) RETURNS jsonb`.

```sql
CREATE OR REPLACE FUNCTION pgstack.fn_summarize(body jsonb)
RETURNS jsonb LANGUAGE plpython3u AS $$
  import json
  data = json.loads(body)
  result = {"count": len(data.get("items", []))}
  return json.dumps(result)
$$;
```

### Deno

Supabase-compatible Deno runtime via an external sidecar container. Set the `EDGE_RUNTIME_URL` environment variable to point the proxy at your Deno runtime container. Supports full Node.js-like APIs, `fetch`, npm packages via `import`, and TypeScript out of the box.

```bash
# In docker-compose.yml or .env
EDGE_RUNTIME_URL=http://edge-runtime:9000
```

### HTTP

A polyglot runtime: the function is a container in **any** language, and the proxy reverse-proxies to its **per-function** `upstream_url`. It is the same wire contract as Deno (`POST /functions/v1/{name}`, identity via `X-Pgstack-*` headers) but without the single-global-`EDGE_RUNTIME_URL` limitation — each function is its own container.

```sql
INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, upstream_url)
VALUES ('my-fn', 'http', true, 'http://my-fn:8000');
```

See the [HTTP Runtime](./http.md) page and `examples/functions/` for a worked reference (`hello-go`).

## Security

### RLS enforcement

The embedded JS runtime (goja) enforces Row Level Security on all database queries. Each `db.query()` call runs inside a transaction with `SET LOCAL ROLE` matching the caller's JWT claims. This means embedded functions respect the same RLS policies as REST API requests.

Roles are whitelisted (`anon`, `authenticated`, `service_role`) and derived solely from the caller's proxy-validated JWT claims — function code cannot choose its own role, and unrecognized roles fall back to `anon`. An execution timeout prevents infinite loops from blocking the proxy.

### Body size limit

Edge Function requests are subject to the `MAX_BODY_SIZE` limit (default 1 MB) to prevent resource exhaustion.

## API reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/functions/v1/{name}` | POST | JWT or anon | Invoke a function |
| `/functions/v1/{name}` | GET | JWT or anon | Invoke a function (GET) |
| `/functions/v1/` | GET | service_role | List all functions |
| `/functions/v1/_refresh` | POST | service_role | Reload function catalog |
