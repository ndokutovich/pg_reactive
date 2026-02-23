# pg_reactive

A PostgreSQL extension that turns any SQL `SELECT` into a live query. When underlying data changes via `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or `ALTER TABLE`, subscribers receive real-time delta notifications (inserted and deleted rows) over WebSocket.

## Architecture

pg_reactive is a three-layer system:

```
+-------------------+       +------------------+       +------------------+
|  PostgreSQL       |       |  Rust Proxy      |       |  TypeScript SDK  |
|  C Extension      | ----> |  WebSocket       | ----> |  LiveQuery       |
|  (ext/)           | NOTIFY|  Server (proxy/) |  WS   |  Client (sdk/)   |
+-------------------+       +------------------+       +------------------+
```

1. **C Extension** -- Installs into PostgreSQL. Manages subscriptions in shared memory, installs DML triggers and DDL event hooks on tracked tables, computes deltas using EXCEPT-based snapshot comparison, and sends `NOTIFY` on channel `pgr`.

2. **Rust Proxy** -- WebSocket server that bridges PostgreSQL `NOTIFY` to WebSocket clients. Handles JWT authentication, connection limits, and fan-out to multiple clients per `query_id`.

3. **TypeScript SDK** -- Client library with `LiveQuery` class, `createClient()` factory, React `useLiveQuery()` hook, and server-side `PgReactiveAdmin` helper.

## Key Features

- Column-level UPDATE tracking (only fires when subscribed columns change)
- LRU eviction when shared memory slots are full
- Delta payloads with inserted and deleted rows
- Overflow handling for large payloads (>7800 bytes) or lagged clients
- UNLOGGED snapshot tables (no WAL overhead)
- Proper JSON types (numbers unquoted, booleans as `true`/`false`)
- JWT authentication (HS256, token via query param or `Authorization` header)
- Graceful proxy shutdown with connection draining
- Exponential backoff reconnection (both proxy-to-PG and SDK-to-proxy)

## Quick Start

```bash
docker compose up -d
# Extension is auto-loaded via shared_preload_libraries
# Proxy available at ws://127.0.0.1:8080
# PG available at 127.0.0.1:15432
```

Connect to PostgreSQL and register a live query:

```sql
SELECT pgr.subscribe('orders_q', 'SELECT id, total, status FROM orders');
```

Then connect from the SDK:

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

Any `INSERT`, `UPDATE`, or `DELETE` on the `orders` table will now push delta notifications to all connected clients.

## SQL API

All functions live in the `pgr` schema, created automatically by `CREATE EXTENSION pg_reactive`.

### `pgr.subscribe(query_id text, query text) -> jsonb`

Registers a live query. Parses the SQL to extract dependency tables, installs DML triggers, creates an UNLOGGED snapshot table, and records the subscription in shared memory.

```sql
SELECT pgr.subscribe('my_query', 'SELECT id, name FROM users WHERE active');
-- Returns: {"status":"subscribed","tables":1,"query_id":"my_query"}
```

### `pgr.unsubscribe(query_id text) -> boolean`

Removes a subscription. Drops the snapshot table, removes per-query triggers, and frees the shared memory slot.

```sql
SELECT pgr.unsubscribe('my_query');
-- Returns: true (or false if not found)
```

### `pgr.subscriptions` (view)

Lists all active subscriptions with their metadata.

```sql
SELECT * FROM pgr.subscriptions;
-- Columns: query_id, query_text, num_tables, subscribed_at, invalidation_count
```

### `pgr.stats()` (function)

Returns extension-wide statistics.

```sql
SELECT * FROM pgr.stats();
-- Metrics: subscribe_count, unsubscribe_count, invalidation_count, eviction_count, active_subscriptions
```

## SDK

### Installation

```bash
npm install pg-reactive-sdk
```

### Client Usage

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

### React Hook

```tsx
import { useLiveQuery } from "pg-reactive-sdk/react";

function OrderList() {
  const { rows, state, overflow } = useLiveQuery("orders_q", {
    url: "ws://127.0.0.1:8080",
  });

  if (state === "connecting") return <p>Connecting...</p>;
  if (overflow) return <p>Data overflow, please refresh</p>;

  return <ul>{rows.map(r => <li key={String(r.id)}>{String(r.name)}</li>)}</ul>;
}
```

### Server-side Admin

For managing subscriptions from Node.js (requires `pg` as a peer dependency):

```typescript
import { PgReactiveAdmin } from "pg-reactive-sdk/server";

const admin = new PgReactiveAdmin({ connectionString: "postgres://..." });
await admin.register("orders_q", "SELECT * FROM orders");
await admin.unregister("orders_q");
await admin.close();
```

### Client Options

| Option                | Type     | Default    | Description                                      |
|-----------------------|----------|------------|--------------------------------------------------|
| `url`                 | `string` | (required) | WebSocket proxy URL, e.g. `ws://127.0.0.1:8080`  |
| `token`               | `string` | `undefined`| JWT token for authentication                     |
| `reconnectDelay`      | `number` | `1000`     | Initial reconnect delay in ms                    |
| `maxReconnectDelay`   | `number` | `30000`    | Maximum reconnect delay in ms                    |
| `maxReconnectAttempts` | `number` | `Infinity` | Maximum reconnect attempts before giving up      |

### Events

The `LiveQuery.on()` callback receives one of these events:

| Event          | Data Type            | Description                                |
|----------------|----------------------|--------------------------------------------|
| `delta`        | `Delta`              | Rows inserted or deleted                   |
| `overflow`     | `Overflow`           | Payload too large; client should re-fetch  |
| `connected`    | `undefined`          | WebSocket connection established           |
| `disconnected` | `undefined`          | WebSocket connection lost                  |
| `error`        | `Error`              | Connection error                           |

## Wire Format

All messages are JSON, sent over the `pgr` NOTIFY channel (extension to proxy) and over WebSocket (proxy to SDK).

**Delta** -- rows changed:
```json
{"query_id":"q1","inserted":[{"id":1,"name":"Alice"}],"deleted":[]}
```

**Overflow** -- payload exceeded 7800 bytes or client lagged:
```json
{"type":"overflow","query_id":"q1","fetch":true}
```

**Proxy welcome** -- sent on WebSocket connect:
```json
{"type":"subscribed","query_id":"q1"}
```

## Configuration

### Proxy (environment variables)

| Variable         | Default                                                    | Description                        |
|------------------|------------------------------------------------------------|------------------------------------|
| `DATABASE_URL`   | `postgres://postgres:postgres@db:5432/pg_reactive_test`    | PostgreSQL connection string       |
| `LISTEN_ADDR`    | `0.0.0.0:8080`                                             | Bind address for WebSocket server  |
| `JWT_SECRET`     | (unset)                                                    | Enables JWT auth when set          |
| `MAX_CONNECTIONS` | `10000`                                                   | WebSocket connection limit         |

### Extension (postgresql.conf)

| Parameter                         | Default | Restart? | Description                     |
|-----------------------------------|---------|----------|---------------------------------|
| `shared_preload_libraries`        | --      | Yes      | Must include `pg_reactive`      |
| `pg_reactive.max_subscriptions`   | `1024`  | Yes      | Max concurrent subscriptions    |
| `pg_reactive.async_recompute`     | `off`   | Yes      | Use background worker for recompute |

## Testing

The project includes seven levels of testing.

### Extension tests (pg_regress)

7 SQL test files covering setup, subscribe, invalidation, recompute, overflow, coverage, and column tracking:

```bash
docker compose exec db bash -c 'su - postgres -c "cd /ext/ext && make installcheck"'
```

### Isolation tests

3 concurrency specs (concurrent_dml, concurrent_subscribe, concurrent_invalidation) with 9 permutations:

```bash
docker compose exec db bash -c 'su - postgres -c "cd /ext/ext && make isolation_installcheck"'
```

### SDK unit tests

```bash
cd sdk && npm test
```

### E2E tests

WebSocket delta delivery, multi-client fan-out, and JWT authentication:

```bash
node tests/e2e_ws_test.mjs
node tests/e2e_fanout_test.mjs
JWT_SECRET=test node tests/e2e_jwt_test.mjs
```

### Integration tests

Shared memory pressure (200 subscriptions) and NOTIFY throughput (200 writes, 100% delivery):

```bash
docker compose exec db bash -c 'cd /ext && python3 tests/integration/test_shmem_pressure.py'
docker compose exec db bash -c 'cd /ext && python3 tests/integration/test_notify_throughput.py'
```

### Benchmarks

pgbench baseline vs subscribed workloads:

```bash
docker compose exec db bash -c 'cd /ext && bash ext/bench/bench_runner.sh'
```

### Performance Tests

6 stress tests measuring real-world limits (write throughput, snapshot scaling, E2E latency, fan-out, sustained load, multi-table cascade):

```bash
bash tests/perf/runner.sh                # Full suite (~10 min)
node tests/perf/p3_e2e_latency.mjs       # Individual host test
docker compose exec -T db bash -c 'python3 /ext/tests/perf/p1_write_throughput.py'  # Individual container test
```

## Project Structure

```
ext/                          PostgreSQL C extension
  src/
    pg_reactive.c             Subscribe/unsubscribe/stats functions, query parsing
    dependency.c              Shared memory hash table with LRU eviction
    invalidation.c            DML triggers, DDL event hooks, dirty tracking
    recompute.c               EXCEPT-based delta computation, NOTIFY dispatch
    bgworker.c                Optional background worker for async recompute
  pg_reactive--0.1.sql        Extension install script (creates pgr schema)
  pg_reactive.control         Extension metadata
  Makefile                    PGXS build configuration
  sql/                        pg_regress test SQL (7 files)
  expected/                   Expected test output
  specs/                      Isolation test specifications (3 specs)
  bench/                      Benchmark scripts

proxy/                        Rust WebSocket proxy
  src/main.rs                 Hyper + tungstenite WS server with JWT auth

sdk/                          TypeScript SDK
  src/
    index.ts                  LiveQuery class, createClient factory
    react.ts                  useLiveQuery React hook
    server.ts                 PgReactiveAdmin server helper

tests/                        End-to-end and integration tests
  e2e_ws_test.mjs             WebSocket delta delivery
  e2e_fanout_test.mjs         Multi-client fan-out
  e2e_jwt_test.mjs            JWT authentication (5 scenarios)
  integration/                Stress and throughput tests
  perf/                       Performance stress tests (6 tests + runner)

examples/                     10 interactive demo applications
  01-live-products/           Basic WHERE filter
  02-order-feed/              Multi-table JOIN (x3)
  03-revenue-dashboard/       LEFT JOIN + GROUP BY + SUM aggregates
  04-category-leaderboard/    HAVING + RANK() window function
  05-realtime-crm/            CTE + LIMIT + multi-query dashboard
  06-inventory-monitor/       CASE + JOIN computed status
  07-multi-filter/            Multiple WHERE filters on same table
  08-order-analytics/         date_trunc + GROUP BY time buckets
  09-price-comparison/        RANK, NTILE, ratio window functions
  10-executive-scorecard/     Single-row aggregate KPIs

docker-compose.yml            Dev environment (PostgreSQL + proxy)
Dockerfile.dev                PostgreSQL 16 with build tools
```

## Requirements

- PostgreSQL 16+
- Rust 1.70+ (for proxy)
- Node.js 18+ (for SDK)
- Docker and Docker Compose (for development)

## How It Works

1. **Subscribe**: `pgr.subscribe('q1', 'SELECT ...')` parses the query to find dependency tables and referenced columns, installs AFTER triggers on those tables, creates an UNLOGGED snapshot table with the initial query result, and stores the subscription in shared memory.

2. **Invalidation**: When a DML statement fires on a tracked table, the trigger checks whether the modified columns overlap with the subscription's column mask. If they do, it marks the subscription as dirty.

3. **Recompute**: The trigger re-executes the original query, compares the new result to the stored snapshot using `EXCEPT` (in both directions), and produces a delta of inserted and deleted rows.

4. **Notify**: The delta is serialized to JSON and sent via `pg_notify('pgr', ...)`. If the payload exceeds 7800 bytes, an overflow message is sent instead.

5. **Proxy fan-out**: The Rust proxy listens on the `pgr` channel and forwards each delta to all WebSocket clients subscribed to that `query_id`.

6. **SDK apply**: The SDK's `LiveQuery` class receives the delta, updates its local row snapshot, and fires the registered event listeners.

## License

PostgreSQL License. See [LICENSE](LICENSE) file.
