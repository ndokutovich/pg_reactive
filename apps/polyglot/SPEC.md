# Polyglot Matching Engines — design spec

A side-by-side comparison of six identical-contract order-matching engines
written in Go, Spring Boot, FastAPI, Rust, .NET, and Node. They all consume
the same order stream, run independently, and publish their fills + book
state back to pgstack so the frontend can show the differences in flight.

This is the **pitch**: not "look, the same handler in six languages" — but
"look, six independent matching engines processing the same orders, with
visibly different fill rates, latencies, and book states." A pgstack
deployment where the database is the message bus and the polyglot workers
are interchangeable building blocks.

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │                pgstack                       │
                 │  ┌─────────────────────────────────────┐    │
                 │  │ public.order_events  (append-only)  │    │
                 │  │ public.engine_fills  (per-engine)   │    │
                 │  │ public.engine_book   (per-engine)   │    │
                 │  │ public.engine_stats  (per-engine)   │    │
                 │  └────────────┬────────────────────────┘    │
                 │               │ LISTEN order_event_added    │
                 │               ▼                              │
                 └───────────────┼──────────────────────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬────────────┐
        ▼            ▼           ▼           ▼            ▼
   ┌────────┐  ┌────────┐  ┌──────────┐ ┌──────┐  ┌──────────┐
   │ engine │  │ engine │  │  engine  │ │engine│  │  engine  │
   │   go   │  │ spring │  │ fastapi  │ │ rust │  │  dotnet  │
   └────────┘  └────────┘  └──────────┘ └──────┘  └──────────┘
        │            │           │           │            │
        └────────────┴───────────┼───────────┴────────────┘
                                 │ writes fills + book + stats
                                 ▼
                         frontend live-queries:
                           top_of_book_BTCUSD
                           recent_fills_{engine}
                           engine_book_{engine}_BTCUSD
                           engine_perf_summary
```

Each engine is a long-running container that:

1. Opens one PostgreSQL connection.
2. `LISTEN order_event_added` for the heads-up.
3. On notification, reads its own `last_seen_id` and pulls the new orders
   from `public.order_events` since then.
4. Processes them through its in-memory order book.
5. Writes fills to `public.engine_fills` and rebuilds its book rows in
   `public.engine_book`.

No HTTP server. No edge-function reverse proxy. The engine is a worker that
talks to pgstack the way a real polyglot stream-processor would.

## Shared schema

`apps/polyglot/shared/migration.sql` is the single source of truth. It
ships with the polyglot deploy template and is also bundled into the demo
landing.

### `public.order_events` — append-only ledger

| column        | type        | meaning |
|---------------|-------------|---------|
| `id`          | bigserial   | sequence; engines use it as a watermark |
| `ts`          | timestamptz | server-side `now()` |
| `symbol`      | text        | e.g. `BTC-USD` |
| `side`        | text        | `buy` or `sell` |
| `order_type`  | text        | `limit`, `market`, `cancel` |
| `price`       | numeric     | null for market / cancel |
| `qty`         | numeric     | for cancel: 0 |
| `client_id`   | text        | UUID — the placing party |
| `parent_order`| bigint      | for `cancel`: ref to original order |

After every `INSERT` a trigger fires `pg_notify('order_event_added', id)`.
Engines use the payload to skip the round-trip when the only thing they
need is the watermark.

### `public.engine_fills` — per-engine matching decisions

| column         | type      | meaning |
|----------------|-----------|---------|
| `id`           | bigserial | |
| `engine`       | text      | `go` / `spring` / `fastapi` / `rust` / `dotnet` / `node` |
| `ts`           | timestamptz | when the engine recorded the fill |
| `order_id`     | bigint    | which order in `order_events` triggered this fill |
| `matched_qty`  | numeric   | partial fills allowed |
| `fill_price`   | numeric   | the matching price |
| `latency_us`   | int       | engine-reported processing time |
| `taker_side`   | text      | `buy` / `sell` — the side that crossed the spread |

The frontend live-queries `recent_fills_{engine}` (last 20 per engine, sorted
desc by `ts`).

### `public.engine_book` — per-engine top-of-book snapshot

| column        | type      | meaning |
|---------------|-----------|---------|
| `engine`      | text      | composite PK |
| `symbol`      | text      | composite PK |
| `side`        | text      | composite PK |
| `price`       | numeric   | composite PK |
| `total_qty`   | numeric   | aggregate remaining at this price level |
| `order_count` | int       | number of resting orders at this level |
| `updated_at`  | timestamptz | |

Engines maintain this via UPSERT — one row per (engine, symbol, side, price).
Empty levels are deleted.

### `public.engine_stats` — rolling perf counters

| column          | type     | meaning |
|-----------------|----------|---------|
| `engine`        | text PK  | |
| `total_orders`  | bigint   | orders seen |
| `total_matches` | bigint   | fills produced |
| `total_volume`  | numeric  | summed matched_qty |
| `avg_latency_us`| numeric  | rolling average |
| `p99_latency_us`| numeric  | rolling p99 (engine-side reservoir) |
| `last_updated`  | timestamptz | |

Updated by each engine after each batch of fills.

## Live queries

Registered in `migration.sql` via `pgr.subscribe`:

| query_id                          | what the frontend gets |
|-----------------------------------|------------------------|
| `top_of_book_BTCUSD`              | top-10 bid + top-10 ask, aggregated across all 6 engines |
| `recent_fills_{engine}`           | last 20 fills per engine (six subscriptions) |
| `engine_book_{engine}_BTCUSD`     | full book per engine (depth chart) |
| `engine_perf_summary`             | one row per engine — for the stats panel |

All subscriptions have `audience = null` (read-only public data) — anyone with
a valid JWT (including guest JWT via `signInAnonymously`) can watch.

## Engine contract

Every engine is a container with **one entry point**: a worker process that
connects to pgstack's PostgreSQL and loops on the order stream. No HTTP
listener.

### Required behaviour

1. Connect to `DATABASE_URL` (env). The connection uses a dedicated role
   `polyglot_engine` granted only what's listed in `migration.sql`.
2. `LISTEN order_event_added`.
3. On every notification, run `SELECT * FROM public.order_events WHERE id > $1`
   where `$1` is `last_seen_id`.
4. For each order, run the engine-native matching algorithm against the
   in-memory book.
5. For each generated fill: INSERT into `engine_fills`.
6. Update `engine_book` rows for the affected price levels.
7. Update `engine_stats` row at the end of each batch.

### Environment variables

| var                 | required | meaning |
|---------------------|----------|---------|
| `DATABASE_URL`      | yes      | `postgres://polyglot_engine:...@pgstack:5432/pg_reactive_test` |
| `ENGINE_NAME`       | yes      | `go` / `spring` / `fastapi` / `rust` / `dotnet` / `node` |
| `LATENCY_HISTOGRAM` | no       | reservoir size for p99 (default 1024) |

### Matching algorithm (reference)

Standard **price-time priority** (FIFO at each price level). Limit orders rest
in the book at their price. Incoming limit orders that cross the spread match
the resting opposite side from best price outward until exhausted. Market
orders take the top of book; cancels remove the parent order.

This is the reference. Engines MAY deviate (pro-rata, hidden tick, etc) —
the deviation is the demonstration. If they deviate, the engine README
documents what they do differently and why.

## Frontend

Single static page at `apps/polyglot/web/index.html`. Loads from CDN, no build.

Layout — three rows × dynamic columns:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Header — symbol selector, "send random order" button, play/pause   │
├─────────────────────────────────────────────────────────────────────┤
│  Aggregated top-of-book (one panel, 10 deep both sides)             │
├─────────────────────────────────────────────────────────────────────┤
│  6-grid: per-engine mini-panels (fills + p99 latency + book depth)  │
│   ┌──────┬──────┬──────┐                                            │
│   │  go  │spring│fastpi│                                            │
│   ├──────┼──────┼──────┤                                            │
│   │ rust │dotnet│ node │                                            │
│   └──────┴──────┴──────┘                                            │
├─────────────────────────────────────────────────────────────────────┤
│  Consensus monitor: where engines disagree on top-of-book           │
└─────────────────────────────────────────────────────────────────────┘
```

The "send random order" button POSTs to `POST /rest/v1/rpc/place_order`
(a SECURITY DEFINER function that wraps the INSERT and assigns the
`client_id` from `auth.uid()`). One synthetic generator container can be
toggled on for ambient activity (configurable rate).

## Deploy

`deploy/templates/polyglot-showcase/` — a separate template mirroring
`deploy/templates/shop/`. Same network topology (gateway alias `polyglot-web`),
same one-shot migration container, plus six engine sidecars and one order
generator. Umbrella nginx routes `polyglot.pgstack.org` to it via tracked
`deploy/umbrella/app-polyglot.conf`.

## Implementation order

1. **`apps/polyglot/shared/migration.sql`** — schema + role + RLS + triggers
   + `pgr.subscribe` registrations + `place_order` RPC.
2. **`apps/polyglot/engines/go/`** — reference engine. Used as template for
   the other five.
3. **`apps/polyglot/web/`** — frontend.
4. **`apps/polyglot/generator/`** — synthetic order producer (small Go
   service the operator can scale up/down).
5. **`apps/polyglot/engines/{spring,fastapi,rust,dotnet,node}/`** — port the
   Go reference; each is its own commit.
6. **`deploy/templates/polyglot-showcase/`** + umbrella conf — deployment.

Steps 1–2 land together as Phase D groundwork; the others can ship one at a
time without blocking earlier work.
