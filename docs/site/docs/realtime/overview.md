---
title: Live Queries Overview
sidebar_position: 1
description: Real-time SQL subscriptions powered by the pg_reactive PostgreSQL C extension.
---

# Live Queries Overview

pgStack's real-time system is powered by `pg_reactive` — a PostgreSQL C extension that turns any `SELECT` query into a live subscription. When underlying data changes, the extension computes a diff and delivers only the changed rows to connected clients.

## How it works

```
Your App (WebSocket client)
  │
  │  ws://127.0.0.1:8080/ws/my_query_id
  │
pgStack Proxy (Rust)
  │  LISTEN pgr
  │
PostgreSQL
  │
  ├── AFTER INSERT/UPDATE/DELETE triggers (installed by pg_reactive)
  │       │
  │       └── recompute.c: runs your SELECT query twice (before/after snapshot)
  │                         computes EXCEPT diff
  │                         NOTIFY 'pgr' with JSON delta
  │
  └── Snapshot tables: pgr._snapshot_<query_id>  (UNLOGGED, in-memory)
```

### Delta delivery

When a row changes in a subscribed table:

1. An AFTER STATEMENT trigger fires
2. pg_reactive re-runs your query and computes the difference using SQL `EXCEPT`
3. The diff is serialized as JSON and published via `pg_notify('pgr', ...)`
4. The proxy receives the NOTIFY, routes it to subscribed WebSocket connections
5. The SDK receives the delta, applies it to the local snapshot

### Delta format

```json
{
  "query_id": "active_orders",
  "inserted": [
    {"id": 42, "status": "active", "customer": "Jane Doe", "amount": 149.99}
  ],
  "deleted": [
    {"id": 37, "status": "active", "customer": "Bob Smith", "amount": 29.99}
  ]
}
```

`inserted` contains rows that appeared in the result set. `deleted` contains rows that disappeared. For an UPDATE that changes a non-subscribed column, both arrays may be empty.

## Why SQL-level deltas?

Traditional real-time systems (Debezium, Supabase Realtime) deliver raw WAL events — every INSERT, UPDATE, DELETE on every row. This means:
- The client must understand your data model to know if a change affects the query result
- Filtered queries (e.g., `WHERE status = 'active'`) require client-side filtering
- Aggregates and JOINs cannot be subscribed to

pg_reactive subscribes at the **query level**. If you subscribe to `SELECT * FROM orders WHERE status = 'active'`, you only receive deltas when the active orders set changes. An update to `orders.notes` (not in your SELECT) doesn't trigger a notification.

## Performance characteristics

| Scenario | P50 latency | Notes |
|----------|-------------|-------|
| E2E (write → client) | 3 ms | Docker on Windows |
| Snapshot on 1K rows | 2.8 ms | EXCEPT diff |
| Snapshot on 10K rows | 18.5 ms | |
| Snapshot on 100K rows | 263 ms | Not recommended |
| 1 subscriber | ~222 TPS write throughput | |
| 10 subscribers | ~99 TPS write throughput | |
| 200 WebSocket clients | 0 missed deltas | Fan-out test |

For best performance, keep subscribed queries fast (indexed columns, small result sets).

## Overflow handling

PostgreSQL `NOTIFY` payloads are limited to ~7800 bytes. If a delta is too large, the proxy sends an overflow message instead:

```json
{"type": "overflow", "query_id": "active_orders", "fetch": true}
```

The SDK clears its local snapshot and emits an `overflow` event. Your application should re-fetch the full query result via the REST API.

## Connection format

WebSocket URL:

```
ws://127.0.0.1:8080/ws/{query_id}
ws://127.0.0.1:8080/ws/{query_id}?token={jwt}
```

The proxy sends a confirmation message after connection:

```json
{"type": "subscribed", "query_id": "active_orders"}
```

## Message types

| Type | Description |
|------|-------------|
| `{"type":"subscribed","query_id":"..."}` | Connection confirmed |
| `{"query_id":"...","inserted":[...],"deleted":[...]}` | Delta update |
| `{"type":"overflow","query_id":"...","fetch":true}` | Delta too large, re-fetch needed |
| `{"type":"invalidated","query_id":"..."}` | Query invalidated (notify mode) |
| `{"type":"error","message":"..."}` | Auth or connection error |
| `{"type":"presence_join","channel":"...","client_id":"...","state":{}}` | Client joined channel |
| `{"type":"presence_leave","channel":"...","client_id":"..."}` | Client left channel |
| `{"type":"presence_state","channel":"...","client_id":"...","state":{}}` | Client updated presence |

## Presence

Presence tracks which clients are currently connected to a channel and their live state (cursor position, online status, typing indicator, etc.). Presence is **ephemeral** — held in proxy memory and lost on restart.

Clients join automatically when connecting via WebSocket. To update state, send a message:

```json
{"type": "presence", "state": {"username": "jane", "status": "online"}}
```

To poll current presence via HTTP:

```bash
curl http://127.0.0.1:8080/ws/_presence/my_channel
```

See the [API Reference](../reference/api#presence) for the full presence protocol.

## Next steps

- [Subscribe to a Live Query](./subscribe) — register queries in PostgreSQL
- [SDK Reference](./sdk) — `LiveQuery` class and `createClient()`
- [React Hook](./react) — `useLiveQuery()` for React apps
