# pg_reactive / pgStack

A PostgreSQL extension that turns any SQL `SELECT` into a live query with real-time delta notifications. Built on top: **pgStack** — an open-source Supabase alternative providing auth, REST API, and CLI tooling.

## Architecture

```
+-------------------+       +------------------+       +------------------+
|  PostgreSQL       |       |  Rust Proxy      |       |  TypeScript SDK  |
|  C Extension      | ----> |  axum Server     | ----> |  LiveQuery       |
|  (ext/)           | NOTIFY|  (proxy/)        |  WS   |  Client (sdk/)   |
+-------------------+       +------------------+       +------------------+
                            |  Auth, REST,     |       |  CLI (cli/)      |
                            |  OAuth, RLS      |       |  pgstack init/   |
                            +------------------+       |  dev/migrate/gen |
                                                       +------------------+
```

### Layers

1. **C Extension** — Manages subscriptions in shared memory, installs DML triggers and DDL event hooks, computes deltas using EXCEPT-based snapshot comparison, sends `NOTIFY` on channel `pgr`.

2. **Rust Proxy (axum)** — Modular server providing:
   - WebSocket fan-out (pg_reactive live queries)
   - Auth endpoints (signup, login, refresh, logout, OAuth)
   - PostgREST-compatible REST API (CRUD, resource embedding, RPC)
   - RLS middleware (per-request `SET LOCAL role` + JWT claims)
   - Rate limiting, CORS, CSP security headers

3. **TypeScript SDK** — `LiveQuery` client, React `useLiveQuery()` hook, server-side `PgReactiveAdmin`.

4. **CLI** — `pgstack` command for project scaffolding, dev server, migrations, and type generation.

## Quick Start

```bash
docker compose up -d
# Proxy: http://127.0.0.1:8080
# PostgreSQL: 127.0.0.1:15432
```

Or with the CLI:

```bash
npx pgstack init my-app
cd my-app
npx pgstack dev
```

## Auth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/v1/signup` | Create account (email + password) |
| `POST` | `/auth/v1/token` | Login (`grant_type=password` or `refresh_token`) |
| `GET` | `/auth/v1/user` | Get current user (JWT required) |
| `PATCH` | `/auth/v1/user` | Update user metadata |
| `POST` | `/auth/v1/logout` | Logout (invalidates refresh token) |
| `GET` | `/auth/v1/authorize` | OAuth redirect (Google, GitHub) |
| `GET` | `/auth/v1/callback` | OAuth callback |

Authentication: `Authorization: Bearer <token>` header or `apikey: <key>` header.

## REST API (PostgREST-compatible)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rest/v1/{table}` | Select rows with filters |
| `POST` | `/rest/v1/{table}` | Insert rows (returns created) |
| `PATCH` | `/rest/v1/{table}` | Update rows matching filters |
| `DELETE` | `/rest/v1/{table}` | Delete rows matching filters |
| `GET/POST` | `/rest/v1/rpc/{function}` | Call PostgreSQL function |

### Filters

PostgREST-compatible query parameters: `?column=op.value`

| Operator | Example | SQL |
|----------|---------|-----|
| `eq` | `?status=eq.active` | `status = 'active'` |
| `neq` | `?status=neq.deleted` | `status != 'deleted'` |
| `gt`, `gte`, `lt`, `lte` | `?price=gt.100` | `price > 100` |
| `like`, `ilike` | `?name=ilike.*alice*` | `name ILIKE '%alice%'` |
| `in` | `?id=in.(1,2,3)` | `id IN (1, 2, 3)` |
| `is` | `?deleted=is.null` | `deleted IS NULL` |

### Resource Embedding

FK-based joins via `select` parameter:

```
GET /rest/v1/posts?select=id,title,authors(name)
GET /rest/v1/authors?select=*,posts(id,title)
```

### Ordering, Pagination, Column Selection

```
GET /rest/v1/products?select=id,name&order=name.asc&limit=10&offset=20
```

### RPC

```
POST /rest/v1/rpc/my_function
Content-Type: application/json
{"arg1": "value1", "arg2": 42}
```

## Live Queries (pg_reactive)

Register a live query in PostgreSQL:

```sql
SELECT pgr.subscribe('orders_q', 'SELECT id, total, status FROM orders');
```

Connect from the SDK:

```typescript
import { createClient } from "pg-reactive-sdk";

const client = createClient({ url: "ws://127.0.0.1:8080", token: "jwt..." });
const orders = client.subscribe("orders_q");

orders.on((event, data) => {
  if (event === "delta") console.log("Changes:", data);
  if (event === "overflow") console.log("Re-fetch needed");
});

console.log(orders.snapshot); // current rows
client.close();
```

### SQL API

All functions in the `pgr` schema (created by `CREATE EXTENSION pg_reactive`):

| Function | Description |
|----------|-------------|
| `pgr.subscribe(query_id, query)` | Register a live query |
| `pgr.unsubscribe(query_id)` | Remove a subscription |
| `pgr.subscriptions` (view) | List active subscriptions |
| `pgr.stats()` | Extension-wide statistics |

### Wire Format

All messages are JSON over the `pgr` NOTIFY channel (extension to proxy) and WebSocket (proxy to SDK):

```json
{"query_id":"q1","inserted":[{"id":1,"name":"Alice"}],"deleted":[]}
{"type":"overflow","query_id":"q1","fetch":true}
{"type":"subscribed","query_id":"q1"}
```

## SDK

```bash
npm install pg-reactive-sdk
```

### React Hook

```tsx
import { useLiveQuery } from "pg-reactive-sdk/react";

function OrderList() {
  const { rows, state } = useLiveQuery("orders_q", {
    url: "ws://127.0.0.1:8080",
  });
  if (state === "connecting") return <p>Connecting...</p>;
  return <ul>{rows.map(r => <li key={String(r.id)}>{String(r.name)}</li>)}</ul>;
}
```

### Server-side Admin

```typescript
import { PgReactiveAdmin } from "pg-reactive-sdk/server";

const admin = new PgReactiveAdmin({ connectionString: "postgres://..." });
await admin.register("orders_q", "SELECT * FROM orders");
await admin.unregister("orders_q");
await admin.close();
```

## CLI

```bash
pgstack init <project>     # Scaffold a new pgStack project
pgstack dev                # Start dev environment (docker compose up)
pgstack dev stop           # Stop dev environment
pgstack dev logs           # Tail proxy logs
pgstack migration new <n>  # Create a new migration file
pgstack migration up       # Apply pending migrations
pgstack migration list     # List migration status
pgstack db psql            # Open psql shell
pgstack db reset           # Reset database
pgstack generate types     # Generate TypeScript types from schema
```

## Configuration

### Proxy Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://...@db:5432/app` | PostgreSQL connection string |
| `LISTEN_ADDR` | `0.0.0.0:8080` | Bind address |
| `JWT_SECRET` | (unset) | Enables JWT auth (32+ chars) |
| `ANON_KEY` | (unset) | Anonymous API key |
| `SERVICE_ROLE_KEY` | (unset) | Service role API key (bypasses RLS) |
| `MAX_CONNECTIONS` | `10000` | Max WebSocket connections |
| `SITE_URL` | (unset) | Required for OAuth redirects |
| `GOOGLE_CLIENT_ID` | (unset) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | (unset) | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | (unset) | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | (unset) | GitHub OAuth client secret |
| `AUTH_RATE_LIMIT` | `30` | Auth endpoint rate limit (requests/window) |
| `AUTH_RATE_WINDOW` | `60` | Rate limit window (seconds) |
| `ACCESS_TOKEN_EXPIRY_SECS` | `3600` | JWT access token TTL |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token TTL |
| `BROADCAST_CAPACITY` | `1024` | Internal broadcast channel capacity |
| `MAX_BODY_SIZE` | `1048576` | Request body limit (bytes) |
| `PG_RECONNECT_MAX_BACKOFF` | `30` | Max PG reconnect backoff (seconds) |
| `ENABLE_SQL_ENDPOINT` | `false` | Enable `/api/sql` (dev only) |
| `ALLOWED_ORIGINS` | (unset) | Comma-separated CORS origins |

### Extension (postgresql.conf)

| Parameter | Default | Restart? | Description |
|-----------|---------|----------|-------------|
| `shared_preload_libraries` | — | Yes | Must include `pg_reactive` |
| `pg_reactive.max_subscriptions` | `1024` | Yes | Max concurrent subscriptions |
| `pg_reactive.async_recompute` | `off` | Yes | Background worker for async recompute |

## Testing

### Extension tests

```bash
# pg_regress (8 SQL test files)
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make installcheck"'

# Isolation tests (3 concurrency specs)
docker compose exec -T db bash -c 'su - postgres -c "cd /ext/ext && make isolation_installcheck"'
```

### SDK + CLI unit tests

```bash
cd sdk && npx vitest run        # 42 tests
cd cli && npx vitest run        # 36 tests
```

### E2E tests (require docker compose)

```bash
node tests/e2e_ws_test.mjs          # WebSocket delta delivery
node tests/e2e_fanout_test.mjs      # Multi-client fan-out
node tests/e2e_jwt_test.mjs         # JWT auth scenarios
node tests/e2e_auth_test.mjs        # Auth endpoints (37 tests)
node tests/e2e_rest_test.mjs        # REST CRUD (34 tests)
node tests/e2e_rls_test.mjs         # RLS middleware (12 tests)
node tests/e2e_rpc_test.mjs         # RPC function calls (30 tests)
node tests/e2e_embed_test.mjs       # Resource embedding (55 tests)
node tests/e2e_oauth_test.mjs       # OAuth flow (10 tests)
node tests/e2e_sdk_test.mjs         # SDK integration (29 tests)
```

### Integration + Performance

```bash
# Integration
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_shmem_pressure.py'
docker compose exec -T db bash -c 'cd /ext && python3 tests/integration/test_notify_throughput.py'

# Performance suite (~10 min)
bash tests/perf/runner.sh
```

## Project Structure

```
ext/                              PostgreSQL C extension
  src/
    pg_reactive.c                 Subscribe/unsubscribe, query parsing
    dependency.c                  Shared memory hash with LRU eviction
    invalidation.c                DML triggers, DDL hooks, dirty tracking
    recompute.c                   EXCEPT-based delta, NOTIFY dispatch
    bgworker.c                    Optional async recompute worker
  pg_reactive--0.1.sql            Extension install script (pgr schema)
  sql/                            pg_regress tests (8 files)
  expected/                       Expected test output
  specs/                          Isolation test specs (3 files)

proxy/                            Rust proxy (axum)
  src/
    main.rs                       Router, WebSocket handler, shutdown
    config.rs                     Environment variable configuration
    state.rs                      Shared app state (pool, catalog, channels)
    error.rs                      Error types
    auth/                         JWT, password hashing, OAuth, API keys
    rest/                         Catalog, filters, query builder, handlers, embedding, RPC
    realtime/                     PG LISTEN loop, WebSocket fan-out
    middleware/                   CORS, rate limiting, RLS, security headers
    routes/                       Health, SQL endpoint, demo, catalog refresh

cli/                              pgstack CLI tool
  src/
    index.ts                      Commander entry point
    commands/                     init, dev, migration, db, generate
    lib/                          Config, crypto, docker, pg helpers

sdk/                              TypeScript SDK
  src/
    index.ts                      LiveQuery client
    react.ts                      useLiveQuery React hook
    server.ts                     PgReactiveAdmin server helper

tests/                            E2E, integration, and performance tests
  e2e_*.mjs                       11 E2E test suites (~270 tests)
  integration/                    Shared memory + throughput stress tests
  perf/                           6 performance tests + runner

examples/                         12 interactive demos + 4 shopping list apps
  01-live-products/ .. 12-tutorial/
  apps/                           Full-stack shopping list apps (Angular, React, Svelte, Vue)

docker-compose.yml                Dev environment (PostgreSQL + proxy)
Dockerfile.dev                    PostgreSQL 16 with build tools
```

## Requirements

- PostgreSQL 16+
- Rust 1.88+ (for proxy)
- Node.js 18+ (for SDK and CLI)
- Docker and Docker Compose (for development)

## License

PostgreSQL License. See [LICENSE](LICENSE) file.
