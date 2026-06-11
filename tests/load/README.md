# Load Tests

k6-based load tests for the pgStack proxy.

## Requirements

- k6 v0.45+: https://k6.io/docs/get-started/installation/
- Docker Compose stack running: `docker compose up -d`

## Test Files

| File | What it tests |
|------|--------------|
| `auth_load.js` | POST /auth/v1/signup at up to 100 VUs (~35 s ramp/hold/down); counts 429s to surface rate limiting |
| `rest_load.js` | GET/POST/DELETE /rest/v1/{table} at 50 VUs for 60 s; p95 < 200 ms |
| `ws_load.js` | 200 simultaneous connections to GET /ws/{query_id} for a pre-registered subscription; verifies the `subscribed` welcome on > 99 % of connections |

## Setup

```bash
docker compose up -d
```

For the REST load test, create the test table first:

```sql
CREATE TABLE IF NOT EXISTS load_test_items (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  val  INTEGER DEFAULT 0
);
GRANT ALL ON load_test_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE load_test_items_id_seq TO authenticated;
```

## Run

```bash
# Auth endpoints (signup)
k6 run tests/load/auth_load.js

# REST API CRUD
k6 run --env AUTH_TOKEN=eyJhbG... tests/load/rest_load.js

# WebSocket connections (200 simultaneous)
k6 run tests/load/ws_load.js
```

## Environment Variables

All scripts accept these variables via `--env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://127.0.0.1:8080` | Proxy base URL |
| `AUTH_TOKEN` | (empty) | Bearer token for REST tests — required: the default compose sets `JWT_SECRET`, so tokenless requests get 401; even with auth disabled they run as `anon`, which has no grants on the test table |
| `JWT_TOKEN` | (empty) | JWT for WebSocket tests — required under the default compose (`JWT_SECRET` is set; tokenless upgrades get 401) |
| `TABLE` | `load_test_items` | Table name for REST tests |
| `LOGIN_EMAIL` | `loadtest_seed@example.invalid` | Pre-seeded login email |
| `LOGIN_PASSWORD` | `LoadTest!Passw0rd` | Pre-seeded login password |

Example with overrides:

```bash
k6 run --env BASE_URL=http://127.0.0.1:8080 \
       --env AUTH_TOKEN=eyJhbG... \
       tests/load/rest_load.js
```

## Thresholds

Each script enforces:

- `auth_load.js`: p95 signup < 2000 ms, error rate < 5 %
- `rest_load.js`: p95 reads < 200 ms, p95 writes < 500 ms, error rate < 1 %
- `ws_load.js`: subscription delivery > 99 %, connection failures < 2

k6 exits with a non-zero code if any threshold is breached, making these
suitable as CI quality gates (run them after integration tests pass).
