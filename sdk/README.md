# @pgstack/sdk

TypeScript client for **pg_reactive** live queries. You register a SQL query in
PostgreSQL once, subscribe to it from the browser or Node, and receive
incremental deltas over WebSocket instead of polling or refetching.

## Install

```bash
npm install @pgstack/sdk
```

## Quick start

```ts
import { createClient } from "@pgstack/sdk";

const client = createClient({
  url: "ws://127.0.0.1:8080",
  // token: "your-jwt", // only when the proxy runs with JWT_SECRET
});

// A query registered server-side with pgr.subscribe('active_orders', 'SELECT ...')
const orders = client.subscribe("active_orders");

orders.on((event, data) => {
  if (event === "delta") console.log("changed", data);
});

console.log(orders.snapshot); // rows as of now
client.close();                // closes every subscription opened by this client
```

Events are `delta`, `overflow`, `invalidated`, `connected`, `disconnected` and
`error`. An `overflow` means the change was too large to send inline — refetch
the snapshot.

## React

```tsx
import { useLiveQuery } from "@pgstack/sdk/react";

function Orders() {
  const { rows, state } = useLiveQuery("orders_summary", {
    url: "ws://127.0.0.1:8080",
  });
  return <pre>{JSON.stringify(rows, null, 2)}</pre>;
}
```

## Entry points

| Import | Contents |
|---|---|
| `@pgstack/sdk` | `createClient`, `LiveQuery`, `LiveQueryHub`, `createHub`, `RealtimeChannel` |
| `@pgstack/sdk/react` | `useLiveQuery` |
| `@pgstack/sdk/server` | `PgReactiveAdmin` — server-side subscription management over `pg` |
| `@pgstack/sdk/pgstack` | REST/auth client for the pgStack proxy |
| `@pgstack/sdk/pgstack-react` | React bindings for the above |
| `@pgstack/sdk/dbos` | durable workflow client |

## Links

- Documentation: https://pgstack.org
- Source: https://github.com/ndokutovich/pg_reactive/tree/master/sdk
- Issues: https://github.com/ndokutovich/pg_reactive/issues

## License

Apache-2.0
