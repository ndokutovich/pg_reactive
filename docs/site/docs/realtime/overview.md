---
title: Realtime
sidebar_position: 1
description: Realtime in pgStack — live queries powered by the pg_reactive extension, wired into pgStack auth, RLS, and the SDK.
---

# Realtime

pgStack's realtime layer is **[pg_reactive](/pg-reactive/)** — a PostgreSQL C extension that turns any `SELECT` into a live query and pushes JSON deltas over `LISTEN`/`NOTIFY`. pgStack bundles the extension, runs the WebSocket fan-out proxy for you, and ties subscriptions into the platform's auth and Row-Level Security.

This page covers the **pgStack integration**. For the engine itself — standalone install, the full SQL subscription API, the wire protocol, GUCs, the security model, and the SDK — see the dedicated **[pg_reactive documentation](/pg-reactive/)**.

## How it fits together

```
Your App (WebSocket client)
  │  ws://127.0.0.1:8080/ws/{query_id}?token={jwt}
  ▼
pgStack Proxy (Go)        ← auth, audience gate, connection limits
  │  LISTEN pgr
  ▼
PostgreSQL + pg_reactive  ← AFTER STATEMENT triggers → EXCEPT diff → NOTIFY 'pgr'
```

A row changes → pg_reactive re-runs your query, diffs it against the stored snapshot with SQL `EXCEPT`, and emits a JSON delta on the `pgr` channel. The proxy receives the `NOTIFY` and routes it to the WebSocket connections subscribed to that `query_id`.

## Connecting from a client

```
ws://127.0.0.1:8080/ws/{query_id}
ws://127.0.0.1:8080/ws/{query_id}?token={jwt}
```

The proxy confirms the subscription, then streams deltas:

```json
{"type": "subscribed", "query_id": "active_orders"}
{"query_id": "active_orders", "seq": 17, "inserted": [/* … */], "deleted": [/* … */]}
```

The TypeScript SDK manages this socket, applies deltas to a local snapshot, and re-fetches on overflow — see the [SDK](/pg-reactive/sdk) and [React hook](/pg-reactive/react) pages. The complete message catalogue lives in [Wire Format](/pg-reactive/wire-format).

## Registering a query

Subscriptions are registered in PostgreSQL with `pgr.subscribe()`. Because the stored SQL is later re-executed by `SECURITY DEFINER` triggers, **never grant `pgr.subscribe` directly to app roles** — expose it through a purpose-built `SECURITY DEFINER` wrapper with a fixed query template and a server-derived `query_id`/audience. The full reasoning and the canonical wrapper pattern are in the [Security Model](/pg-reactive/security-model); see [The Subscription API](/pg-reactive/subscribe) for the function reference.

## Auth & RLS integration

pgStack adds two things on top of the bare extension:

- **Audience-bound subscriptions.** A subscription registered with an `audience` (e.g. `{"sub":"42"}`) is only served to a client whose JWT satisfies it; everyone else is rejected with `403` at WS-connect, before any data flows. This closes capability leakage even if a client guesses the `query_id`. See [Row-Level Security](./../auth/rls.md) for the worked example.
- **Defence in depth with RLS.** The snapshot is filtered by the query's `WHERE` at subscribe time, and your table `ROW LEVEL SECURITY` policies still apply when the proxy is not using `service_role`.

## Next steps

- **[pg_reactive — the extension](/pg-reactive/)** — the full engine documentation
- [The Subscription API](/pg-reactive/subscribe) — `pgr.subscribe`, modes, lifecycle
- [Wire Format](/pg-reactive/wire-format) — every message the channel emits
- [Security Model](/pg-reactive/security-model) — the privileged-API footgun and the safe pattern
