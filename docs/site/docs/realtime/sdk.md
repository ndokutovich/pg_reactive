---
title: SDK Reference
sidebar_position: 3
description: LiveQuery class, createClient(), and RealtimeChannel API reference.
---

# SDK Reference

The `@pgstack/sdk` package provides the TypeScript client for live query subscriptions.

## Installation

```bash
npm install @pgstack/sdk
```

## `createClient()`

Create a client that manages multiple live queries with shared connection options:

```typescript
import { createClient } from '@pgstack/sdk';

const client = createClient({
  url: 'ws://127.0.0.1:8080',
  token: 'your-jwt-token',  // optional
});

// Subscribe to a live query
const orders = client.subscribe('active_orders');

// Close all subscriptions
client.close();
```

### Options

```typescript
interface LiveQueryClientOptions {
  /** WebSocket proxy URL, e.g. "ws://127.0.0.1:8080" */
  url: string;

  /** JWT token — passed as ?token= query param */
  token?: string;

  /** Reconnect delay in ms (default: 1000) */
  reconnectDelay?: number;

  /** Maximum reconnect delay with exponential backoff (default: 30000) */
  maxReconnectDelay?: number;

  /** Maximum reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}
```

## `LiveQuery` class

The `LiveQuery` class manages a single WebSocket subscription.

### Constructor

```typescript
import { LiveQuery } from '@pgstack/sdk';

const lq = new LiveQuery('active_orders', {
  url: 'ws://127.0.0.1:8080',
  token: session.access_token,
});
```

### `.snapshot`

The current snapshot of query results. Read-only array:

```typescript
const rows: ReadonlyArray<DeltaRow> = lq.snapshot;
// DeltaRow = Record<string, unknown>
```

The snapshot is updated automatically when deltas arrive. It is initially empty and populated by the first delta message.

### `.on(listener)`

Register an event listener. Returns an unsubscribe function:

```typescript
const unsubscribe = lq.on((event, data) => {
  switch (event) {
    case 'connected':
      console.log('WebSocket connected');
      break;

    case 'disconnected':
      console.log('WebSocket disconnected, will reconnect');
      break;

    case 'delta':
      const delta = data as Delta;
      console.log('Inserted:', delta.inserted);
      console.log('Deleted:', delta.deleted);
      console.log('Current snapshot:', lq.snapshot);
      break;

    case 'overflow':
      // Delta was too large, local snapshot was cleared
      // Re-fetch the full result from REST API
      const overflow = data as Overflow;
      console.log('Overflow, need to re-fetch:', overflow.query_id);
      break;

    case 'invalidated':
      // Query was invalidated (notify mode)
      console.log('Query invalidated, re-fetch needed');
      break;

    case 'error':
      const error = data as Error;
      console.error('WebSocket error:', error.message);
      break;
  }
});

// Unsubscribe
unsubscribe();
```

### Event types

| Event | Data type | Description |
|-------|-----------|-------------|
| `connected` | — | WebSocket connection established |
| `disconnected` | — | WebSocket disconnected (reconnect will follow) |
| `delta` | `Delta` | Rows inserted/deleted from the query result |
| `overflow` | `Overflow` | Payload too large, local snapshot cleared |
| `invalidated` | `Invalidation` | Query invalidated, re-fetch recommended |
| `error` | `Error` | Connection or protocol error |

### `.close()`

Close the WebSocket connection and stop reconnecting:

```typescript
lq.close();
```

### `.queryId`

The query ID this instance is subscribed to:

```typescript
console.log(lq.queryId); // 'active_orders'
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

## `RealtimeChannel`

A general-purpose WebSocket channel for pub/sub messaging:

```typescript
const ch = client.channel('presence');

ch.subscribe((event, data) => {
  if (event === 'message' && data?.type === 'broadcast') {
    console.log('from peer', data.from, data.payload);
  }
});

ch.send({ user: 'alice', status: 'online' });

// Close when done
ch.unsubscribe();
```

### Wire format

`channel.send(payload)` emits `{"type":"broadcast","payload":<your data>}` on the wire. The server wraps it as `{"type":"broadcast","from":"<peer-id>","payload":<your data>}` before fanning out to other subscribers — so receivers can always distinguish a peer broadcast from a server-side live-query delta (`{inserted,deleted}`) or presence event (`type:"presence_*"`). Any other client-originated message type (including unstructured payloads) is dropped server-side, which closes the "hostile peer forges a delta" injection vector.

### Methods

| Method | Description |
|--------|-------------|
| `.subscribe(callback)` | Register a callback and open the connection |
| `.send(payload)` | Broadcast a JSON payload to channel peers (server wraps with `from`) |
| `.unsubscribe()` | Close the connection and remove all callbacks |

### Channel events

| Event | Description |
|-------|-------------|
| `connected` | WebSocket opened |
| `disconnected` | WebSocket closed |
| `message` | Frame received. Inspect `data.type` to classify: `broadcast` (peer), `presence_*` (presence), or absence of `type` + `inserted`/`deleted` (server delta). |
| `error` | Connection error |

## `LiveQueryHub`

`createHub()` is the recommended entry point for apps that need optimistic updates, offline support, or multiple subscriptions sharing one set of connection options:

```typescript
import { createHub } from '@pgstack/sdk';

const hub = createHub({ url: 'ws://127.0.0.1:8080', token: '...' });

const orders = hub.subscribe('orders_q');
orders.on((event, data) => console.log(event, data));

// Optimistic insert — shows in the UI immediately:
orders.optimisticInsert({ id: 999, status: 'pending' });
try {
  await hub.mutate(() =>
    fetch('/rest/v1/orders', { method: 'POST', body: JSON.stringify(row) }),
  );
  orders.commitOptimistic();
} catch {
  orders.rollback();
}

hub.close(); // close all subscriptions
```

### Options

`HubOptions` extends `LiveQueryClientOptions` with:

| Option | Default | Description |
|--------|---------|-------------|
| `maxOfflineQueue` | `100` | Maximum mutations queued while offline — the oldest is dropped when full |

### Hub methods

| Method | Description |
|--------|-------------|
| `.subscribe(queryId)` | Returns a `HubSubscription` with optimistic-update helpers |
| `.mutate(fn)` | Runs the mutation now if online; queues it (and replays on reconnect) if offline |
| `.queueMutation(fn)` | Queue a mutation explicitly for replay on reconnect |
| `.pendingMutations` | Number of mutations currently queued |
| `.close()` | Close all subscriptions and the underlying client |

### `HubSubscription` helpers

| Method | Description |
|--------|-------------|
| `.optimisticInsert(row)` | Insert a row into the local snapshot immediately |
| `.optimisticDelete(row)` | Remove a row from the local snapshot immediately |
| `.commitOptimistic()` | Accept the optimistic state (after the server confirmed) |
| `.rollback()` | Revert the snapshot to the last server-confirmed state |

## Full example

```typescript
import { createClient } from '@pgstack/sdk';

const client = createClient({
  url: 'ws://127.0.0.1:8080',
  // sessionStorage is tab-scoped — closing the browser logs the user
  // out; XSS cannot survive a browser restart. The React `useAuth` hook
  // persists the whole session as JSON under the 'pgstack-session' key.
  token: (JSON.parse(sessionStorage.getItem('pgstack-session') ?? 'null') as
    { access_token?: string } | null)?.access_token,
});

// Subscribe to active orders
const ordersQuery = client.subscribe('active_orders');

let snapshot = ordersQuery.snapshot;

const unsubscribe = ordersQuery.on((event, data) => {
  if (event === 'delta') {
    snapshot = ordersQuery.snapshot;
    renderOrders(snapshot);
  }

  if (event === 'overflow') {
    // Re-fetch from REST
    fetchOrdersFromRest().then(rows => renderOrders(rows));
  }

  if (event === 'disconnected') {
    showReconnectingBanner();
  }

  if (event === 'connected') {
    hideReconnectingBanner();
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  client.close();
});
```

## Reconnection behavior

The SDK automatically reconnects on disconnect using exponential backoff with jitter:

```
Attempt 1: 1000ms + random(0-500ms)
Attempt 2: 2000ms + random(0-500ms)
Attempt 3: 4000ms + random(0-500ms)
...
Max: 30000ms
```

Configure with `reconnectDelay` and `maxReconnectDelay` options.
