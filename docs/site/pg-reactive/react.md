---
title: React Hook
sidebar_position: 11
description: useLiveQuery, the React 18/19 hook that binds a pg_reactive live query to component state.
---

# React Hook

`useLiveQuery` is the React binding for pg_reactive. It subscribes to a live
query through the WebSocket proxy, keeps a local snapshot in sync as deltas
arrive, and re-renders your component whenever the result set changes. Under the
hood it is a thin wrapper around the [`LiveQuery` class](./sdk.md) — same
connection, same reconnect logic, same wire format ([wire-format](./wire-format.md)),
exposed as idiomatic React state.

The hook ships in the same package as the rest of the SDK and is imported from
the `react` subpath:

```typescript
import { useLiveQuery } from '@pgstack/sdk/react';
```

React (`>=18`) is an optional peer dependency — it is whatever React is already
in your app. The hook works unchanged under React 18 and 19.

## Prerequisites

Before a component can subscribe, the query must be registered server-side with
`pgr.subscribe()` (see [subscribe](./subscribe.md)) and the [Go proxy](./proxy.md)
must be running and reachable. The `queryId` you pass to the hook is the same id
you passed to `pgr.subscribe()`.

```sql
SELECT pgr.subscribe(
  'active_orders',
  'SELECT id, status, amount FROM orders WHERE status IN (''pending'', ''processing'')'
);
```

## Signature

```typescript
function useLiveQuery(
  queryId: string,
  options: LiveQueryClientOptions,
): UseLiveQueryResult;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `queryId` | `string` | The query id registered with `pgr.subscribe()`. Maps to the proxy path `ws://host:8080/ws/{queryId}`. |
| `options` | `LiveQueryClientOptions` | Connection options for the WebSocket proxy (see below). |

### Options

`LiveQueryClientOptions` is the same object the bare [`LiveQuery`](./sdk.md)
constructor takes. Only `url` is required.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | WebSocket proxy base URL, e.g. `ws://127.0.0.1:8080`. Use `ws://` (or `wss://`), never `http://`. The hook appends `/ws/{queryId}` and the `?token=` query param for you. |
| `token` | `string` | — | JWT (HS256) sent as the `?token=` query param. Required when the proxy runs with `JWT_SECRET` set; omit when auth is disabled. |
| `reconnectDelay` | `number` | `1000` | Initial reconnect delay in ms. Reconnection uses exponential backoff with jitter. |
| `maxReconnectDelay` | `number` | `30000` | Upper bound for the backoff delay in ms. |
| `maxReconnectAttempts` | `number` | `Infinity` | Stop reconnecting after this many failed attempts. |

## Return value

```typescript
interface UseLiveQueryResult {
  /** Current snapshot of query results. */
  rows: ReadonlyArray<Record<string, unknown>>;

  /** WebSocket connection state. */
  state: 'connecting' | 'connected' | 'disconnected';

  /** The last delta event received, or null. */
  lastDelta: Delta | null;

  /** True after an overflow — the snapshot was cleared; re-fetch the full result. */
  overflow: boolean;

  /** True after a notify-mode invalidation — re-fetch the full result. */
  invalidated: boolean;

  /** The last connection/parse error, or null. */
  error: Error | null;

  /** Tear down and re-open the connection. */
  reconnect: () => void;
}
```

| Field | When it changes |
|-------|-----------------|
| `rows` | On every `delta`, set to the hook's internal snapshot after applying inserts/deletes. Reset to `[]` on `overflow`. Starts empty. |
| `state` | `'connecting'` on mount and after `reconnect()`; `'connected'` once the socket opens; `'disconnected'` when it closes. |
| `lastDelta` | On every `delta`, the raw `{ query_id, inserted, deleted }` payload. |
| `overflow` | Set `true` when the proxy sends an overflow message (payload exceeded the channel limit, or the snapshot column layout changed). Cleared on the next delta. |
| `invalidated` | Set `true` for queries subscribed in `notify` mode when an `invalidated` message arrives. Cleared on the next delta. |
| `error` | Set on a connection or message error; cleared when the socket reconnects. |
| `reconnect` | Stable callback. Closes the current `LiveQuery` and opens a fresh one. |

`Delta` is `{ query_id: string; inserted: Record<string, unknown>[]; deleted: Record<string, unknown>[] }`.

## Minimal example

```tsx
import { useLiveQuery } from '@pgstack/sdk/react';

function OrderList() {
  const { rows, state, error } = useLiveQuery('active_orders', {
    url: 'ws://127.0.0.1:8080',
  });

  if (state === 'connecting') return <p>Connecting…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {rows.map(row => (
        <li key={String(row.id)}>
          {String(row.status)} — ${String(row.amount)}
        </li>
      ))}
    </ul>
  );
}
```

`rows` is a plain array of row objects. The hook maintains the snapshot for you:
when a row is inserted into the underlying result, it appears in `rows`; when it
leaves the result, it disappears. You never wire up the WebSocket yourself.

## Passing a JWT

When the proxy is started with `JWT_SECRET` (HS256, ≥32 chars — see
[proxy](./proxy.md) and [security-model](./security-model.md)), every connection
must carry a token. Pass it via `options.token`; the hook forwards it as the
`?token=` query param.

```tsx
function OrderList({ token }: { token: string }) {
  const { rows, state } = useLiveQuery('active_orders', {
    url: 'ws://127.0.0.1:8080',
    token,
  });
  // …
}
```

If you use the pgStack umbrella, the JWT is the `access_token` from your auth
session; pgStack also ships a `useAuth` hook that manages that session for you.
Connecting directly to the extension's proxy, the token is any HS256 JWT signed
with the same secret.

## Handling overflow and invalidation

A live query does not always deliver a clean row diff. Two cases require the
client to re-fetch the full result:

- **Overflow** — the NOTIFY payload would exceed the channel byte limit, or an
  `ALTER TABLE` changed the snapshot's column layout. The proxy sends an
  overflow signal, the hook clears `rows`, and sets `overflow = true`.
- **Invalidation** — for queries registered in `notify` mode, the extension
  sends a bare "something changed" signal instead of a row diff. The hook sets
  `invalidated = true`.

In both cases you fetch the authoritative result yourself (over REST, the SDK's
query builder, or a plain `fetch`) and render that until the next delta arrives.

```tsx
import { useEffect, useState } from 'react';
import { useLiveQuery } from '@pgstack/sdk/react';
import { createClient } from '@pgstack/sdk/pgstack';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

function ActiveOrders() {
  const { rows, state, overflow, invalidated, error, reconnect } =
    useLiveQuery('active_orders', { url: 'ws://127.0.0.1:8080' });

  const [refetched, setRefetched] = useState<Record<string, unknown>[] | null>(null);

  // Re-fetch the full result whenever the diff stream can't be trusted.
  useEffect(() => {
    if (!overflow && !invalidated) return;
    pgstack
      .from('orders')
      .select('*')
      .in('status', ['pending', 'processing'])
      .then(({ data }) => setRefetched(data as Record<string, unknown>[]));
  }, [overflow, invalidated]);

  // Once a fresh delta lands, the live snapshot is trustworthy again.
  useEffect(() => {
    if (!overflow && !invalidated) setRefetched(null);
  }, [rows, overflow, invalidated]);

  const displayRows = refetched ?? rows;

  return (
    <div>
      {state === 'disconnected' && (
        <button onClick={reconnect}>Reconnect</button>
      )}
      {error && <p className="error">Error: {error.message}</p>}
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {displayRows.map(row => (
            <tr key={String(row.id)}>
              <td>{String(row.id)}</td>
              <td>{String(row.status)}</td>
              <td>${String(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

The `createClient` import above is the pgStack query builder, used here only as
a convenient way to re-fetch. With the extension alone you can re-fetch with any
HTTP client that reaches your database.

## Best practices

**Memoize the options object.** The hook re-opens the connection when `queryId`
or `options.url` changes. If you build `options` inline on every render with a
*new* `url` string each time, you would thrash the socket — in practice `url` is
a constant, so this is rarely an issue, but when the URL is derived, memoize it:

```tsx
import { useMemo } from 'react';

function OrderList({ host, token }: { host: string; token: string }) {
  const options = useMemo(
    () => ({ url: `ws://${host}:8080`, token }),
    [host, token],
  );
  const { rows } = useLiveQuery('active_orders', options);
  // …
}
```

**Handle the initial render.** On mount `rows` is `[]` and `state` is
`'connecting'`. Render a loading state so you don't flash an empty list before
the first snapshot arrives.

**One hook per query.** Each `useLiveQuery` call owns one `LiveQuery` and one
socket. To watch several queries, call the hook several times — React's rules of
hooks apply (fixed order, top level only).

**Effects are cleaned up automatically.** When the component unmounts, the hook
closes the underlying `LiveQuery` and releases the socket. You do not need a
manual teardown.

## Relationship to the `LiveQuery` class

`useLiveQuery` constructs a [`LiveQuery`](./sdk.md) in a `useEffect`, registers a
listener for its `connected` / `disconnected` / `delta` / `overflow` /
`invalidated` / `error` events, and maps each one onto a piece of React state.
The snapshot you see in `rows` is the same `LiveQuery.snapshot` the class
maintains. If you need behavior the hook does not expose — driving a query
outside React, server-side subscription management, or the optimistic-update
hub — drop down to the class directly. The [SDK page](./sdk.md) covers the full
surface.

## See also

- [SDK](./sdk.md) — the `LiveQuery` class this hook wraps, plus `createClient` and `PgReactiveAdmin`.
- [Wire format](./wire-format.md) — the delta, overflow, and invalidation messages the hook reacts to.
- [Subscribe](./subscribe.md) — registering the `queryId` with `pgr.subscribe()`.
- [Proxy](./proxy.md) — the WebSocket server, JWT auth, and the `ws://host:8080/ws/{query_id}` endpoint.
- pgStack platform: [Realtime overview](/realtime/overview) and [RLS](/auth/rls) for auth-scoped live queries.
