# pgStack Examples

Seven concentrated lessons + two full apps. Each is the canonical
"do it right" shape — no demo-only shortcuts, no patterns to un-learn.

## Quick start

```bash
cd examples
docker compose up -d --build
```

Brings up: PostgreSQL with `pg_reactive`, the Go proxy, the polyglot
`hello-go` edge function, the `setup` container that runs every
`*/setup.sql`, and an nginx serving this directory.

Open <http://127.0.0.1:3000> and click through.

| Service         | Port              | What                         |
| --------------- | ----------------- | ---------------------------- |
| `web`           | `3000` (host)     | static examples + nginx      |
| `proxy`         | `8080`            | pgStack proxy (REST/WS/auth) |
| `db`            | `15432`           | PostgreSQL + pg_reactive     |
| `hello-go`      | (internal :9100)  | reference edge function      |

## Layout

```
examples/
├── _lib/pgstack.js          shared browser SDK helper (PgStack class)
├── 01-live-public/          public live query
├── 02-joins-aggregates/     joins, GROUP BY, window functions
├── 03-per-user-inventory/   audience-bound subscription (flagship)
├── 04-rls-shopping-list/    RLS + audience for multi-tenant data
├── 05-notify-mode/          notify vs delta side-by-side
├── 06-presence-broadcast/   peer-to-peer chat + presence
├── 07-edge-function/        runtime='http' invocation
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
LiveQuery, RealtimeChannel, Edge-function invocation — used by every
example and app. No build step, no bundler. Read the file: it's the
shortest path to understanding the wire shape.

```js
const pg = new PgStack();
await pg.autoAuth();                          // signup / re-login from localStorage

const qid = await pg.rest('/rpc/subscribe_my_inventory', { method: 'POST', body: '{}' });
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
