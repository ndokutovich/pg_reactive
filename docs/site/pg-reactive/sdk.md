---
title: TypeScript SDK
sidebar_position: 10
description: The @pgstack/sdk client — subscribe to a live query, track its snapshot, and react to delta, overflow, and invalidation events.
---

# TypeScript SDK

`@pgstack/sdk` is the browser/Node client for pg_reactive live queries. It opens
a WebSocket to the [proxy](./proxy.md), receives the delta stream a subscription
emits, and maintains a **local snapshot** of the query result so your UI always
has the current rows without re-fetching from Postgres.

The SDK talks only to the proxy — it never connects to Postgres directly. You
register the subscription server-side (`pgr.subscribe`, see
[Subscribe](./subscribe.md)), then the client connects to
`ws://host:8080/ws/{query_id}` and the proxy fans the
[wire-format](./wire-format.md) messages to it.

## Install

```bash
npm install @pgstack/sdk
```

The package ships subpath exports:

| Import | Purpose |
|--------|---------|
| `@pgstack/sdk` | `LiveQuery`, `createClient`, `createHub`, `RealtimeChannel` — the live-query client |
| `@pgstack/sdk/react` | `useLiveQuery` React hook (see [React](./react.md)) |
| `@pgstack/sdk/server` | `PgReactiveAdmin` — Node-only subscription management over `pg` |

The live-query client uses only the standard `WebSocket` global, so it runs in
the browser and in any Node 22+ / Bun / Deno runtime that provides one.

## `createClient()`

`createClient` is the simplest entry point: it manages several subscriptions
that share one set of connection options.

```typescript
import { createClient } from '@pgstack/sdk';

const client = createClient({
  url: 'ws://127.0.0.1:8080',
  token: 'your-jwt-token', // optional — only when the proxy has JWT_SECRET set
});

// Subscribe to a query that was registered with pgr.subscribe('active_orders', ...)
const orders = client.subscribe('active_orders');

// Close every subscription opened through this client
client.close();
```

### Options

```typescript
interface LiveQueryClientOptions {
  /** WebSocket proxy URL, e.g. "ws://127.0.0.1:8080" */
  url: string;

  /** JWT token — passed as the ?token= query param on the WebSocket URL */
  token?: string;

  /** Initial reconnect delay in ms (default: 1000) — grows with backoff */
  reconnectDelay?: number;

  /** Cap on the reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;

  /** Maximum reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}
```

`client.subscribe(queryId)` returns a [`LiveQuery`](#livequery-class). The client
keeps a reference to each one so `client.close()` can tear them all down.

`client.channel(name)` returns a `RealtimeChannel` for general pub/sub messaging
that is unrelated to live queries (see [Realtime channels](#realtime-channels)).

## `LiveQuery` class

`LiveQuery` manages a single subscription. `createClient().subscribe()` builds
one for you, but you can construct it directly:

```typescript
import { LiveQuery } from '@pgstack/sdk';

const lq = new LiveQuery('active_orders', {
  url: 'ws://127.0.0.1:8080',
  token: session.access_token,
});
```

The constructor opens the WebSocket immediately — to
`${url}/ws/active_orders?token=...` — so the connection is live as soon as the
instance exists.

### `.snapshot`

A read-only array of the current query rows. It starts **empty** and is filled
by the first delta the proxy sends after you connect.

```typescript
const rows: ReadonlyArray<DeltaRow> = lq.snapshot;
// DeltaRow = Record<string, unknown>
```

The SDK keeps `snapshot` in sync automatically: each `delta` event applies its
`inserted`/`deleted` rows to the local array before your listener runs, so by
the time you read `lq.snapshot` inside a `delta` handler it already reflects the
change. Deletes are matched by **value** (an order-independent key over the
row's keys/values), not by identity — you do not need a primary key in the
result for delete matching to work.

### `.on(listener)`

Register an event listener. Returns a function that removes it.

```typescript
const off = lq.on((event, data) => {
  switch (event) {
    case 'connected':
      // WebSocket open (also fires after every successful reconnect)
      break;

    case 'disconnected':
      // Socket closed — a reconnect is already scheduled
      break;

    case 'delta': {
      const delta = data as import('@pgstack/sdk').Delta;
      // delta.inserted / delta.deleted are the rows that changed.
      // lq.snapshot is already updated at this point.
      render(lq.snapshot);
      break;
    }

    case 'overflow':
      // Snapshot was cleared — re-fetch the full result (see below)
      break;

    case 'invalidated':
      // notify-mode signal: data changed, no rows shipped — re-fetch
      break;

    case 'error': {
      const err = data as Error;
      console.error('live query error:', err.message);
      break;
    }
  }
});

off(); // stop listening (does not close the socket)
```

### Events

| Event | Data | When it fires |
|-------|------|---------------|
| `connected` | — | WebSocket opened, including after a reconnect |
| `disconnected` | — | WebSocket closed; a reconnect is scheduled unless you called `.close()` |
| `delta` | `Delta` | Rows were inserted/deleted from the result. `.snapshot` is already updated |
| `overflow` | `Overflow` | The delta was too large (or the column layout changed); `.snapshot` was **cleared** |
| `invalidated` | `Invalidation` | A `mode='notify'` subscription fired — re-fetch the full result yourself |
| `error` | `Error` | The socket could not be created, or a protocol error occurred |

The `subscribed` proxy welcome message is consumed internally — it does **not**
surface as an event.

### Handling `overflow`

A subscription emits an [overflow](./wire-format.md#overflow) instead of a delta
when the JSON payload would exceed the channel's NOTIFY budget, or when the
snapshot's column layout changes (e.g. an `ALTER TABLE`). The SDK responds by
**clearing the local snapshot to `[]`** and emitting `overflow`. Your snapshot
is now empty and stale — you must re-fetch the full result, typically from the
REST surface:

```typescript
lq.on(async (event) => {
  if (event === 'overflow') {
    const rows = await fetch('/rest/v1/orders?status=eq.pending')
      .then((r) => r.json());
    render(rows);
  }
});
```

`overflow` and `invalidated` are the two cases where the snapshot the SDK holds
is not authoritative and a re-fetch is required.

### `.close()`

Closes the WebSocket and stops reconnecting permanently. After `.close()` no
further events fire.

```typescript
lq.close();
```

### `.queryId`

The query id this instance is subscribed to.

```typescript
console.log(lq.queryId); // 'active_orders'
```

## Reconnection

When the socket drops, the SDK reconnects on its own using exponential backoff
with jitter. The delay for attempt _n_ is:

```
delay = min(reconnectDelay * 2^(n-1) + random(0..500ms), maxReconnectDelay)
```

With the defaults (`reconnectDelay: 1000`, `maxReconnectDelay: 30000`):

```
attempt 1:  1000ms + jitter
attempt 2:  2000ms + jitter
attempt 3:  4000ms + jitter
...
capped at:  30000ms
```

A successful reconnect resets the attempt counter to zero. On reconnect the
proxy resends the current state, so the snapshot re-converges — but if you
missed messages while offline, expect an `overflow` (snapshot cleared, re-fetch)
rather than a partial delta. Tune the cadence with `reconnectDelay`,
`maxReconnectDelay`, and bound retries with `maxReconnectAttempts`.

## Passing a JWT

When the proxy runs with `JWT_SECRET` set (HS256, min 32 chars), every
WebSocket must present a token. Pass it as `token`; the SDK appends it as the
`?token=` query parameter on the `/ws/{query_id}` URL.

```typescript
const client = createClient({
  url: 'ws://127.0.0.1:8080',
  token: session.access_token,
});
```

The token's claims also drive **audience filtering**: a subscription registered
with an `audience` (e.g. `{ "sub": "user-123" }`) only delivers deltas to clients
whose JWT carries every matching claim. See [Security model](./security-model.md)
for how audience scoping keeps one user's deltas off another user's socket, and
[RLS](/auth/rls) for the row-level rules the pgStack umbrella layers on top.

## Vanilla TypeScript example

A complete subscription with no framework — connect, render on every change,
re-fetch on overflow, and clean up on unload:

```typescript
import { createClient, type Delta } from '@pgstack/sdk';

const client = createClient({
  url: 'ws://127.0.0.1:8080',
  token: session?.access_token, // omit when the proxy has no JWT_SECRET
});

const orders = client.subscribe('active_orders');

function render(rows: ReadonlyArray<Record<string, unknown>>) {
  const list = document.getElementById('orders')!;
  list.innerHTML = rows
    .map((r) => `<li>#${r.id} — ${r.status}</li>`)
    .join('');
}

orders.on(async (event, data) => {
  switch (event) {
    case 'connected':
      hideBanner();
      break;

    case 'delta':
      // .snapshot is already updated; (data as Delta).inserted/deleted
      // hold the specific rows that changed if you want fine-grained UI.
      render(orders.snapshot);
      break;

    case 'overflow': {
      // Local snapshot was cleared — pull the authoritative result.
      const rows = await fetch('/rest/v1/orders?status=eq.pending')
        .then((r) => r.json());
      render(rows);
      break;
    }

    case 'invalidated': {
      // notify-mode subscription: refetch, no rows were shipped.
      const rows = await fetch('/rest/v1/orders?status=eq.pending')
        .then((r) => r.json());
      render(rows);
      break;
    }

    case 'disconnected':
      showBanner('Reconnecting…');
      break;

    case 'error':
      console.error((data as Error).message);
      break;
  }
});

window.addEventListener('beforeunload', () => client.close());
```

## Types

```typescript
export type DeltaRow = Record<string, unknown>;

export interface Delta {
  query_id: string;
  inserted: DeltaRow[];
  deleted: DeltaRow[];
}

export interface Overflow {
  query_id: string;
  fetch: boolean;
}

export interface Invalidation {
  query_id: string;
}

export type LiveQueryEventType =
  | 'delta'
  | 'overflow'
  | 'invalidated'
  | 'connected'
  | 'disconnected'
  | 'error';

export type LiveQueryListener = (
  event: LiveQueryEventType,
  data?: Delta | Overflow | Invalidation | Error,
) => void;
```

The SDK's `Delta`/`Overflow`/`Invalidation` are the **parsed** shapes your
listener receives. The on-the-wire frames carry an extra per-query `seq`
counter (used to detect gaps); see [Wire format](./wire-format.md) for the raw
JSON.

## Optimistic updates: `createHub()`

For apps that need optimistic UI or an offline mutation queue, `createHub()`
returns a `LiveQueryHub`. Each `hub.subscribe(queryId)` yields a
`HubSubscription` (a `LiveQuery` with optimistic helpers), and `hub.mutate()`
runs a mutation now if connected or queues it for replay on reconnect.

```typescript
import { createHub } from '@pgstack/sdk';

const hub = createHub({ url: 'ws://127.0.0.1:8080', token: '...' });

const orders = hub.subscribe('active_orders');
orders.on(() => render(orders.snapshot));

// Show the row immediately, then confirm against the server:
const row = { id: 999, status: 'pending' };
orders.optimisticInsert(row);
try {
  await hub.mutate(() =>
    fetch('/rest/v1/orders', { method: 'POST', body: JSON.stringify(row) })
      .then((r) => { if (!r.ok) throw new Error('insert failed'); }),
  );
  orders.commitOptimistic(); // server delta is now authoritative
} catch {
  orders.rollback();          // revert to the last server-confirmed snapshot
}

hub.close(); // close every subscription and clear the queue
```

`HubSubscription` adds `optimisticInsert(row)`, `optimisticDelete(row)`,
`commitOptimistic()`, and `rollback()`. The hub auto-commits the optimistic
state whenever a real `delta` arrives, drains its queued mutations in order on
reconnect, and bounds the offline queue at `maxOfflineQueue` (default `100`,
oldest dropped when full). `hub.pendingMutations` reports the queue depth.

## Realtime channels

`client.channel(name)` returns a `RealtimeChannel` — a general-purpose pub/sub
socket that is **not** a live query. Peers broadcast JSON to each other through
the proxy:

```typescript
const ch = client.channel('presence');

ch.subscribe((event, data) => {
  if (event === 'message') console.log('frame:', data);
});

ch.send({ user: 'alice', status: 'online' });

ch.unsubscribe(); // close and drop callbacks
```

`ch.send(payload)` emits `{"type":"broadcast","payload":...}`; the proxy re-wraps
it with the sender's peer id before fanning it out, so receivers can always tell
a peer broadcast apart from a server-side live-query delta. Channel names are
validated client-side (letter/underscore start, then letters/digits/underscores/
hyphens, max 64 chars) to keep them safe to embed in the WebSocket URL.

## Server-side management: `@pgstack/sdk/server`

`PgReactiveAdmin` registers and lists subscriptions directly in Postgres over a
`pg` connection pool. It runs **only in Node** (it `require`s `pg`) and is meant
for backend code that owns subscription lifecycle — not the browser.

```typescript
import { PgReactiveAdmin } from '@pgstack/sdk/server';

const admin = new PgReactiveAdmin({
  connectionString: 'postgres://user:pass@127.0.0.1:5432/mydb',
});

// Wraps pgr.subscribe(query_id, sql, mode, audience::jsonb)
await admin.register(
  'orders_q',
  "SELECT id, total FROM orders WHERE status = 'pending'",
  'delta',                 // or 'notify'
  { sub: 'user-123' },     // optional audience — scopes deltas to one JWT
);

const subs = await admin.listSubscriptions();
await admin.unregister('orders_q'); // wraps pgr.unsubscribe(query_id)
await admin.close();
```

`register()` returns `{ query_id, tables, mode, status }` from `pgr.subscribe`.
Because `pgr.subscribe` stores raw SQL that triggers later re-execute, treat it
as a privileged backend API — never expose `PgReactiveAdmin` or raw
`pgr.subscribe` to untrusted clients. See [Security model](./security-model.md)
for the `SECURITY DEFINER` wrapper pattern.

## Next steps

- [React](./react.md) — the `useLiveQuery` hook built on this client.
- [Wire format](./wire-format.md) — the raw delta/overflow/invalidation frames.
- [Proxy](./proxy.md) — the WebSocket server this SDK connects to.
- [Subscribe](./subscribe.md) — registering the query the SDK reads.
- The pgStack umbrella bundles this SDK with REST, auth, and storage; see
  [Quickstart](/quickstart) and the [Realtime overview](/realtime/overview).
