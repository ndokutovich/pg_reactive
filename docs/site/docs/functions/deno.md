---
title: Deno Runtime
sidebar_position: 2
description: Full-featured TypeScript/JavaScript functions using the Supabase edge-runtime.
---

# Deno Runtime

The Deno backend runs functions in the [Supabase edge-runtime](https://github.com/supabase/edge-runtime) — a Deno-based container that supports TypeScript, npm packages, `fetch()`, WebAssembly, and more.

:::tip
`deno` is effectively a special case of the [HTTP runtime](./http.md) with a single, global upstream (`EDGE_RUNTIME_URL`). For a new polyglot function — or when you want each function in its own container — prefer `runtime='http'`.
:::

## Setup

Add the edge-runtime service to your `docker-compose.yml`:

```yaml
edge-runtime:
  image: supabase/edge-runtime:v1.62.2
  environment:
    PGSTACK_DB_URL: postgres://postgres:postgres@db:5432/app
  volumes:
    - ./supabase/functions:/functions:ro
  depends_on:
    db:
      condition: service_healthy
```

Tell the proxy where to find it:

```yaml
proxy-go:
  environment:
    EDGE_RUNTIME_URL: http://edge-runtime:9000
```

## Writing functions

Functions live in `supabase/functions/{name}/index.ts`:

```typescript
Deno.serve(async (req: Request) => {
  // Access auth headers injected by the proxy
  const role = req.headers.get('x-pgstack-role');
  const claims = JSON.parse(req.headers.get('x-pgstack-claims') || '{}');

  // Call external APIs
  const res = await fetch('https://api.example.com/data');
  const externalData = await res.json();

  // Access the database
  const dbUrl = Deno.env.get('PGSTACK_DB_URL');

  return new Response(
    JSON.stringify({ role, externalData }),
    { headers: { "Content-Type": "application/json" } },
  );
});
```

## Deploy

```bash
pgstack functions deploy my-function --runtime deno
```

This registers the function in `pgstack.edge_functions` and refreshes the proxy's catalog. The edge-runtime picks up function files from the mounted volume.

## Features

- Full TypeScript support
- `fetch()` for external API calls
- npm packages via import maps
- WebAssembly support
- Environment variables via `Deno.env`
- Database access via `PGSTACK_DB_URL`
