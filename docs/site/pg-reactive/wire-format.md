---
title: Wire Format
sidebar_position: 5
description: The complete NOTIFY/LISTEN wire protocol pg_reactive emits — message shapes, seq semantics, overflow math, and how to consume it with a bare Postgres client and no proxy.
---

# Wire Format

pg_reactive is, at its core, a `NOTIFY` emitter. Every time a subscribed query's
result set changes, the extension publishes a single JSON message on one
PostgreSQL channel. There is no custom protocol, no binary framing, and no
required broker: anything that can run `LISTEN` against your database can consume
the stream directly.

The [Go proxy](./proxy.md) exists only to fan that one channel out to many
WebSocket clients and to enforce JWT audience checks. The wire format below is
what flows on the channel itself — read it once and you understand both the
raw path and what the proxy forwards.

## The single channel

All notifications for all subscriptions travel on **one** channel. Its name is
controlled by the [`pg_reactive.notify_channel`](./gucs.md) GUC and defaults to
`pgr`:

```sql
SHOW pg_reactive.notify_channel;   -- pgr
```

Messages are not namespaced per query at the channel level — the `query_id`
field inside each JSON payload is how you route. One `LISTEN pgr` sees deltas
for every active subscription in the database; filter on `query_id` yourself.

:::note Proxy is hardcoded to `pgr`
The Go proxy issues a literal `LISTEN pgr`, so changing `notify_channel` away
from the default breaks the end-to-end proxy path. Change it only if you are
consuming the channel directly (see [Consume it with no proxy](#consume-it-with-no-proxy)).
:::

## Message shapes

Four JSON shapes appear on the channel. Three are emitted by the extension
inside PostgreSQL (`delta`, `overflow`, `invalidated`); the fourth (`subscribed`)
is a welcome frame the proxy synthesizes at WebSocket connect and is **not** a
channel message.

### Delta

The default. After an INSERT/UPDATE/DELETE touches a tracked table, the
extension recomputes the query and ships the exact rows that entered and left
the result set:

```json
{
  "query_id": "active_orders",
  "seq": 17,
  "gen": 4,
  "inserted": [
    {"id": 42, "status": "active", "customer": "Jane Doe", "amount": 149.99}
  ],
  "deleted": [
    {"id": 37, "status": "active", "customer": "Bob Smith", "amount": 29.99}
  ]
}
```

- `inserted` — rows that newly appear in the result set.
- `deleted` — rows that disappeared from the result set.
- `gen` — the subscription *generation* this delta was computed under (see
  [Generation](#generation-gen)). The proxy delivers it only to WebSocket
  connections bound to the same generation, so a re-registered subscription's
  rows never reach a connection authorized under the old registration.
- An UPDATE that touches only columns **not** referenced by the query emits no
  message at all — the per-query `AFTER UPDATE OF <cols>` trigger never fires.
- An UPDATE that changes a tracked value appears as the old row in `deleted`
  and the new row in `inserted` (the diff is set-based via SQL `EXCEPT`, not
  row-identity based).

### Overflow

Emitted in `delta` mode when a delta is oversize or the snapshot schema drifts. A delta is dropped and replaced with an overflow signal in two cases:

```json
{"type": "overflow", "query_id": "active_orders", "seq": 18, "gen": 4, "fetch": true}
```

**Case A — payload too large.** PostgreSQL caps a `NOTIFY` payload at 8000
bytes. The extension computes the usable budget per channel as:

```
max_payload = 8000 - len(channel_name) - 100
```

For the default `pgr` channel that is `8000 - 3 - 100 = 7897` bytes. A serialized
delta longer than `max_payload` is discarded and the overflow signal sent in its
place. (This math lives in `PGR_NOTIFY_MAX_PAYLOAD_FOR_CHANNEL` in
`ext/src/recompute.c`.)

**Case B — snapshot column layout drifted.** If the stored snapshot's column
count or types no longer match the live query result — for example after
`ALTER TABLE ... ADD/DROP COLUMN` on a watched table, or a snapshot that
survived from an older deploy under the same `query_id` — the extension rebuilds
the snapshot server-side and emits an overflow so clients drop local state and
re-fetch rather than applying a delta that was never computed.

Treat `overflow` as a generic **"re-fetch the full result set now"** instruction
in both cases, not strictly as "delta too big." Overflow messages carry their
own `seq`, so they never create a gap.

### Invalidated

A subscription registered with `mode => 'notify'` skips delta computation and
snapshots entirely. Each trigger fire emits only a bare "something changed"
signal — the client re-fetches on its own schedule:

```json
{"type": "invalidated", "query_id": "active_orders", "seq": 19, "gen": 4}
```

This is the cache-invalidation mode: cheap, no `EXCEPT`, no snapshot table, no
row payload. You give up knowing *what* changed in exchange for near-zero
server cost. It carries `gen` like every other payload so the proxy can scope
it to the right generation.

### Resubscribed (proxy-consumed control message)

Every `pgr.subscribe`/`pgr.unsubscribe` emits one control message on the channel
announcing the subscription's new generation:

```json
{"type": "resubscribed", "query_id": "active_orders", "gen": 5}
```

This is **not** a data notification and is never forwarded to WebSocket clients.
The proxy consumes it to disconnect connections bound to an older generation
(so their clients reconnect and re-authorize against the new registration). A
raw `LISTEN` consumer will see it and should simply ignore it — the `gen` on
the `delta`/`overflow`/`invalidated` messages is what scopes data; see
[Generation](#generation-gen).

### Proxy welcome (not a channel message)

When a client connects over WebSocket, the [proxy](./proxy.md) immediately sends
one confirmation frame before any deltas:

```json
{"type": "subscribed", "query_id": "active_orders"}
```

This frame is generated by the proxy at connect time. It never appears on the
`pgr` channel — a raw `LISTEN` consumer will never see it.

## Sequence numbers (`seq`)

Every `delta`, `overflow`, and `invalidated` message carries a `seq` field: a
per-`query_id` counter that monotonically increases. It is incremented whenever a
trigger fires for that query, **before** the delta is computed.

Use it to detect missed notifications: if a client sees `seq` jump from 17 to 20,
two notifications between them were not delivered.

One subtlety: a gap does **not** always mean a dropped message. The counter is a
notification-*attempt* counter. If a recompute produces an empty delta (nothing
actually entered or left the set), no `NOTIFY` is sent and that `seq` value is
silently consumed. So a small gap can simply mean "a trigger fired but the result
set was unchanged." A large or persistent gap, by contrast, points at real
NOTIFY queue pressure or a dropped message — treat that as a signal to re-fetch.

## Generation (`gen`)

Every data message (`delta`, `overflow`, `invalidated`) carries a `gen` field: a
monotonic *generation* drawn from a sequence and bumped on every
`pgr.subscribe`/`pgr.unsubscribe` for that `query_id`. It is the epoch the
notification was computed under, and it is the proxy's security boundary for
re-registered subscriptions.

When a WebSocket client connects, the proxy binds it to the subscription's
*current committed* generation. It then delivers a data message to that
connection only if the message's `gen` **exactly matches** the connection's
bound generation. The consequence: if a subscription is re-registered under a
different audience (`public → private`, `tenant A → tenant B`), every
notification computed afterwards carries the new generation and is **never**
delivered to a connection that was authorized under the old one — even for a
notification produced in the brief window before the re-subscribe transaction
commits. A separate `resubscribed` control message then disconnects the stale
connections so their clients reconnect and re-authorize.

A raw `LISTEN` consumer that enforces its own access control can use `gen` the
same way (track the generation it authorized a reader against, drop messages
whose `gen` differs). A consumer that does not need this can ignore the field.

## Message reference

| Shape | JSON | Mode | Source |
|-------|------|------|--------|
| Delta | `{"query_id":"...","seq":N,"gen":G,"inserted":[...],"deleted":[...]}` | `delta` | extension (channel) |
| Overflow | `{"type":"overflow","query_id":"...","seq":N,"gen":G,"fetch":true}` | `delta` | extension (channel) |
| Invalidated | `{"type":"invalidated","query_id":"...","seq":N,"gen":G}` | `notify` | extension (channel) |
| Resubscribed | `{"type":"resubscribed","query_id":"...","gen":G}` | — | extension (channel; proxy-consumed, not forwarded) |
| Subscribed | `{"type":"subscribed","query_id":"..."}` | — | proxy (WS only) |

## Consume it with no proxy

The proxy is a convenience, not a requirement. Because the wire format is just
`NOTIFY` JSON on a single channel, any PostgreSQL client can `LISTEN` and read
the stream directly. Here is the whole thing with two `psql` sessions.

**Session A — subscribe and listen.** Register a delta subscription, then start
listening on the channel:

```sql
-- Register a live query (run as an admin role; see security-model.md).
SELECT pgr.subscribe('active_orders',
                     'SELECT id, status, amount FROM orders WHERE status = ''active''');

-- Listen on the default channel.
LISTEN pgr;
```

`psql` only delivers asynchronous notifications between commands, so after
`LISTEN` either run a trivial statement to flush the queue or leave the session
idle — the next prompt interaction prints anything that arrived.

**Session B — mutate the data.** In a second `psql` connected to the same
database, insert a row that enters the result set:

```sql
INSERT INTO orders (status, amount) VALUES ('active', 149.99);
```

**Session A — the notification arrives.** Back in the first session, the next
time `psql` checks its connection (e.g. you press Enter on an empty line, or run
`SELECT 1;`) it prints the asynchronous notification:

```text
Asynchronous notification "pgr" with payload
"{"query_id":"active_orders","seq":1,"gen":1,"inserted":[{"id":42,"status":"active","amount":149.99}],"deleted":[]}"
received from server process with PID 1234.
```

That payload is byte-for-byte what the proxy would have forwarded to a WebSocket
client. No proxy was involved.

### Any client library works

`LISTEN`/`NOTIFY` is a standard PostgreSQL feature, so any driver with async
notification support consumes the stream the same way — there is nothing
pg_reactive-specific to install on the client. A minimal Node example using the
`pg` driver:

```js
import pg from 'pg';

const client = new pg.Client({
  host: '127.0.0.1',
  port: 15432,
  database: 'postgres',
  user: 'postgres',
});
await client.connect();

client.on('notification', (msg) => {
  // msg.channel === 'pgr'
  const payload = JSON.parse(msg.payload);
  switch (payload.type) {
    case 'overflow':
      // re-fetch the full result set, then resume
      break;
    case 'invalidated':
      // notify-mode hint: re-fetch on your schedule
      break;
    case 'resubscribed':
      // control message: the subscription's generation changed. The proxy uses
      // this to revoke stale connections; a bare listener can ignore it.
      break;
    default:
      // delta: apply payload.inserted / payload.deleted, track payload.seq.
      // payload.gen is the generation the rows belong to.
  }
});

await client.query('LISTEN pgr');
```

The same pattern applies to `psycopg` in Python (`connection.notifies`) and
`pgx` in Go (`conn.WaitForNotification`). In every case you connect, run
`LISTEN pgr`, and parse the JSON payload exactly as documented above — switching
on `payload.type` and routing by `payload.query_id`.

When you outgrow a single listener and need to fan one channel out to thousands
of browser clients with JWT auth, that is precisely what the
[WebSocket proxy](./proxy.md) provides. Until then, a bare `LISTEN` is a complete,
supported consumer.

## See also

- [Proxy](./proxy.md) — the WebSocket fan-out layer that forwards these messages.
- [Subscribe](./subscribe.md) — registering queries and choosing `delta` vs `notify`.
- [GUCs](./gucs.md) — `pg_reactive.notify_channel` and the four other settings.
