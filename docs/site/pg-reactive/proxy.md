---
title: WebSocket Proxy
sidebar_position: 9
description: The optional Go fan-out proxy that turns the NOTIFY pgr channel into WebSocket subscriptions for browser clients.
---

# WebSocket Proxy

The extension emits deltas as PostgreSQL `NOTIFY` messages on a single channel (`pgr` by default). Anything that can `LISTEN pgr` is a valid consumer — a backend worker, a `psql` session, your own service. The proxy is the **optional** layer that turns that one server-side channel into many browser-reachable WebSocket subscriptions.

You do not need the proxy to use pg_reactive. If your consumer already holds a database connection, [LISTEN directly](./wire-format.md) and skip this page. The proxy exists for the case where your clients are browsers, which cannot open raw PostgreSQL connections.

## What it does

```mermaid
flowchart LR
    subgraph PG["PostgreSQL"]
        Notify["NOTIFY 'pgr'<br/>{query_id, seq, ...}"]
    end
    subgraph Proxy["Proxy (Go)"]
        Listen["LISTEN pgr<br/>(one conn)"]
        Hub["Hub"]
        Listen --> Hub
    end
    subgraph Clients["Browser clients"]
        C1["ws://…/ws/orders_q1"]
        C2["ws://…/ws/orders_q1"]
        C3["ws://…/ws/active_users"]
    end
    Notify --> Listen
    Hub -->|"fan-out"| C1
    Hub --> C2
    Hub --> C3
```

One process holds **one** dedicated PostgreSQL connection running `LISTEN pgr`. Every notification is parsed for its `query_id`, then broadcast to exactly the WebSocket clients subscribed to that `query_id` via an in-memory hub. Clients never touch the database directly; they connect to the proxy at:

```
ws://127.0.0.1:8080/ws/{query_id}
ws://127.0.0.1:8080/ws/{query_id}?token={jwt}
```

The `{query_id}` must already be registered with [`pgr.subscribe()`](./subscribe.md). The proxy does not create subscriptions — it only relays them.

### Connection lifecycle

When a client opens `ws://127.0.0.1:8080/ws/{query_id}`, the proxy:

1. **Resolves auth claims** — honours a JWT, the service-role key, or the anon key (see [Auth](#auth-jwt-hs256) below). When `JWT_SECRET` is unset, auth is disabled and the connection is treated as `anon`.
2. **Looks up subscription metadata** (mode and audience) from `pgr.get_subscriptions()`. An unknown `query_id` is rejected with `404` before the upgrade; a metadata lookup failure returns `503` (fail-closed).
3. **Acquires a connection slot** from the semaphore. If the proxy is at capacity, it returns `503` and never upgrades.
4. **Upgrades** the HTTP request to a WebSocket.
5. **Sends the welcome message**: `{"type":"subscribed","query_id":"<id>"}`.
6. **Sends the initial snapshot** read from `pgr._snap_<query_id>` (skipped for `mode='notify'` subscriptions).
7. **Pumps the broadcast channel** — relays every delta, overflow, and invalidation for that `query_id` until the socket closes.

All rejections (401 / 403 / 404 / 503) are returned as plain HTTP responses **before** the WebSocket upgrade, with a JSON body `{"error":"…"}`. No error frame is ever delivered over an established socket.

### What flows over the socket

The proxy is a transparent relay for the channel payloads. After the welcome message, a client sees the [wire-format](./wire-format.md) messages verbatim:

```json
{"type":"subscribed","query_id":"orders_q1"}
{"query_id":"orders_q1","seq":1,"inserted":[{"id":42,"status":"active"}],"deleted":[]}
{"type":"overflow","query_id":"orders_q1","seq":2,"fetch":true}
{"type":"invalidated","query_id":"notify_q","seq":7}
```

The proxy adds the `subscribed` welcome and the initial snapshot; everything else is the extension's NOTIFY payload passed straight through.

## Auth (JWT HS256)

Authentication is enabled when the `JWT_SECRET` environment variable is set (minimum 32 characters; the proxy refuses to start with a shorter secret). When unset, auth is disabled and every connection is `anon` — fine for local development, never for a public host.

With a secret configured, the proxy accepts a token two ways:

- **Query parameter** `?token={jwt}` — the primary mechanism, because browsers cannot set custom headers on a WebSocket upgrade.
- **`Authorization: Bearer {jwt}`** header — for non-browser clients (CLI, server-to-server).

Tokens are HS256-signed and must carry a `sub` claim; `exp` is honoured when present. The anon key may also be presented (via `?apikey=` or `Authorization: Bearer {anon-key}`), which yields a `role: anon` connection. Set `REQUIRE_AUTHENTICATED_WS=true` to reject anon-key subscriptions outright and require a real JWT.

For RLS and role mapping behind the proxy, see the platform's [Row-Level Security guide](/auth/rls).

## Connection limiting

A semaphore caps the number of concurrent WebSocket connections process-wide. The default is **10000**, configurable via `MAX_CONNECTIONS`. Acquisition is non-blocking: when the proxy is full, a new connection gets `503 {"error":"too many WebSocket connections"}` rather than queueing. A second, per-source-IP cap (`WS_MAX_PER_IP`, default 10) limits how many slots any single client address can hold.

## Running it standalone

The Go proxy lives in [`proxy-go/`](https://github.com/ndokutovich/pg_reactive/tree/master/proxy-go). It needs nothing but a reachable PostgreSQL with the extension installed and an active subscription.

### Build

```bash
cd proxy-go
go build ./...
```

### Run

The two environment variables that matter for live queries are `DATABASE_URL` (where to `LISTEN`) and `JWT_SECRET` (auth, optional). The proxy listens on `0.0.0.0:8080` by default (`LISTEN_ADDR`).

```bash
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:15432/postgres"
export JWT_SECRET="a-cryptographically-random-string-at-least-32-chars"
go build -o pgstack-proxy ./...
./pgstack-proxy
```

Omit `JWT_SECRET` to run with auth disabled (the proxy logs a warning). On startup it opens the dedicated `LISTEN pgr` connection, reconnecting with exponential backoff (1s doubling up to `PG_RECONNECT_MAX_BACKOFF`, default 30s) if PostgreSQL drops.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgres://postgres:postgres@db:5432/app` | Connection the proxy uses for `LISTEN pgr` and snapshot reads |
| `LISTEN_ADDR` | `0.0.0.0:8080` | HTTP/WebSocket listen address |
| `JWT_SECRET` | _(unset → auth disabled)_ | HS256 secret; min 32 chars when set |
| `MAX_CONNECTIONS` | `10000` | Process-wide concurrent WebSocket cap (semaphore) |
| `WS_MAX_PER_IP` | `10` | Per-source-IP concurrent WebSocket cap (0 disables) |
| `REQUIRE_AUTHENTICATED_WS` | `false` | Reject anon-key subscriptions; require a real JWT |
| `ALLOWED_ORIGINS` | _(empty → same-origin only)_ | Comma-separated WebSocket `Origin` allowlist |
| `PG_RECONNECT_MAX_BACKOFF` | `30` (seconds) | Cap on listener reconnect backoff |

### Quick test

Subscribe a query in PostgreSQL, then connect:

```bash
# In psql (as a role that may call pgr.subscribe):
SELECT pgr.subscribe('orders_q1', 'SELECT id, status FROM orders');

# From a shell with a WebSocket client (e.g. websocat):
websocat ws://127.0.0.1:8080/ws/orders_q1
# → {"type":"subscribed","query_id":"orders_q1"}
# → initial snapshot, then deltas as orders change
```

## Relationship to the pgStack proxy

There is one proxy binary, not two. The **pgStack proxy** is a superset of this same `proxy-go/` codebase — identical lineage — with the BaaS surface bolted on: auth endpoints, a PostgREST-compatible REST API, RLS middleware, edge functions, the Studio SPA, storage, and webhooks. The WebSocket fan-out described here is the realtime core inside that larger binary.

If all you want is live queries, run it as shown above and ignore the rest of the surface. If you want the batteries-included platform, that is [pgStack](/quickstart) — same realtime layer, plus everything else. The [platform realtime overview](/realtime/overview) documents the proxy in its pgStack role.

## Rust reference proxy

A second implementation lives in [`proxy/`](https://github.com/ndokutovich/pg_reactive/tree/master/proxy) (Rust, axum-based). It is a **reference** implementation that mirrors the same `LISTEN pgr` → Hub → WebSocket flow and the same JWT auth semantics. The Go proxy is the primary, production-targeted path; the Rust proxy exists to keep the protocol honest and document-able from two independent codebases. Build it for a compile check with:

```bash
cd proxy && cargo build
```

## Skipping the proxy

You are not required to use any proxy. The extension's contract is the NOTIFY channel, and that contract is public. A backend service holding a PostgreSQL connection can consume deltas directly:

```sql
LISTEN pgr;
-- every delta / overflow / invalidation arrives as a NOTIFY payload
```

See [Wire Format](./wire-format.md) for the exact message shapes and how to handle overflow re-fetches. The proxy is a convenience for clients that cannot speak the PostgreSQL protocol — nothing more.

## Next steps

- [Wire Format](./wire-format.md) — the JSON message contract on the `pgr` channel
- [SDK](./sdk.md) — the TypeScript `LiveQuery` client that connects to this proxy
- [React Hook](./react.md) — `useLiveQuery()` for React apps
- [Security Model](./security-model.md) — auth, audience scoping, and the privileged `pgr.subscribe` API
