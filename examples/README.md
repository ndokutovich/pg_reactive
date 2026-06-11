# pgStack Examples

Twelve concentrated lessons + two full apps. Each is the canonical
"do it right" shape — no demo-only shortcuts, no patterns to un-learn.

## Quick start

```bash
cd examples
docker network create gateway   # once per machine (shared umbrella network)
docker compose up -d --build
```

Brings up: PostgreSQL with `pg_reactive`, the Go proxy, the polyglot
`hello-go` edge function, the `setup` container that runs every
`*/setup.sql`, and an nginx serving this directory.

Open <http://127.0.0.1:3000> and click through.

| Service         | Default port      | Override env  | What                         |
| --------------- | ----------------- | ------------- | ---------------------------- |
| `web`           | `3000`            | `WEB_PORT`    | static examples + nginx      |
| `proxy`         | `8080`            | `PROXY_PORT`  | pgStack proxy (REST/WS/auth) |
| `db`            | `15432`           | `PG_PORT`     | PostgreSQL + pg_reactive     |
| `hello-go`      | (internal :9100)  | —             | reference edge function      |

## Running multiple projects on one machine

Set the env vars in `.env` (next to `docker-compose.yml`) to dodge port
collisions with other projects:

```env
PG_PORT=25432
PROXY_PORT=18080
WEB_PORT=13000
```

Then bring up normally — Docker compose picks the .env up automatically.

## Production deploy

`docker-compose.prod.yml` is the umbrella override: it resets `ports` so
nothing binds the host, and exposes the proxy as gateway-network alias
`pgr-proxy` for an umbrella nginx to reverse-proxy to; the web service's
`pgr-web` + `pgr-stack` aliases live in the base compose so they don't
depend on the override merge. Used by `.github/workflows/deploy.yml` against
`/opt/apps/pg-reactive-src` on the VPS.

```bash
docker compose \
  -f examples/docker-compose.yml \
  -f examples/docker-compose.prod.yml \
  up -d --build
```

## Layout

```
examples/
├── _lib/pgstack.js          shared browser SDK helper (PgStack class)
├── 01-live-products/        filtered live product grid
├── 02-order-feed/           3-table JOIN order feed
├── 03-revenue-dashboard/    LEFT JOIN + GROUP BY + SUM bar chart
├── 04-category-leaderboard/ HAVING + RANK() window (two subscriptions)
├── 05-realtime-crm/         CTE + LIMIT + GROUP BY, three live panels
├── 06-inventory-monitor/    CASE-bucketed stock alerts
├── 07-multi-filter/         three filtered subscriptions, one table
├── 08-order-analytics/      date_trunc time-bucketed chart
├── 09-price-comparison/     four-window-function matrix
├── 10-executive-scorecard/  single-row aggregate KPIs
├── 11-notify-mode/          notify vs delta side-by-side
├── 12-tutorial/             15-step interactive tutorial console
├── apps/
│   ├── todo/                per-user task tracker
│   └── expenses/            per-user expenses with live totals
├── functions/
│   └── hello-go/            reference http-runtime function
├── docker-compose.yml       full stack
├── nginx.conf               static + reverse proxy
├── config.js                runtime config (auto-detects base path)
└── index.html               landing
```

## Best-practice principles each example follows

1. **RLS first.** Tables for per-user data enable Row-Level Security and
   policies use `auth.uid()`. Even a bug in the proxy or a leaked anon
   key can't escape RLS.

2. **Audience-bound subscriptions.** For user-scoped live data,
   `pgr.subscribe(...)` includes an `audience` predicate (e.g.
   `{"sub":"<uuid>"}`). The proxy enforces it at WebSocket connect
   time — leaking a `query_id` does not leak data.

3. **Server-derived query_ids.** A `SECURITY DEFINER` function reads
   `auth.uid()` and derives both the `query_id` AND the audience. The
   client never invents either; it just calls the helper and uses
   whatever id comes back.

4. **Explicit grants.** Each table grants `SELECT/INSERT/UPDATE/DELETE`
   to the specific roles its policies expect. No blanket
   `GRANT ALL ON ALL TABLES IN SCHEMA public` (closed in the 2026-05
   audit).

5. **Typed broadcast envelope.** Peer messages on channels are wrapped
   server-side as `{"type":"broadcast","from":<peer>,"payload":<orig>}`
   — receivers cannot be tricked into accepting a peer-forged delta.

## Shared SDK (`_lib/pgstack.js`)

A vanilla JS class wrapping the four pgStack capabilities — Auth,
LiveQuery, RealtimeChannel, Edge-function invocation — used by the two
full apps (`apps/todo`, `apps/expenses`); the twelve numbered lessons
intentionally use raw WebSockets so the wire shape stays visible. No
build step, no bundler. Read the file: it's the shortest path to
understanding the wire shape.

```js
const pg = new PgStack();
await pg.autoAuth();                          // signup / re-login from sessionStorage

const qid = await pg.rest('/rpc/subscribe_my_todos', { method: 'POST', body: '{}' });
pg.liveQuery(qid, {
  onSnapshot(rows) { /* initial */ },
  onDelta(ins, del) { /* row-level updates */ }
});
```

## Editing

After changing a `*/setup.sql`:

```bash
docker compose -f examples/docker-compose.yml up -d --build setup
```

After changing the C extension (`ext/`):

```bash
docker compose -f examples/docker-compose.yml build db
docker compose -f examples/docker-compose.yml up -d --force-recreate db
docker compose -f examples/docker-compose.yml up -d setup
```

(The proxy doesn't need rebuilding for SQL/example changes.)
