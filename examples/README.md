# pg_reactive Examples

Twelve progressive examples demonstrating pg_reactive's live query capabilities,
from simple single-table filters to a full CRM dashboard with CTEs, window
functions, notify mode, and an interactive step-by-step tutorial.

## Quick Start (One Command)

```bash
cd examples
docker compose up --build
```

This starts PostgreSQL + pg_reactive extension, the WebSocket proxy, runs all
setup SQL, and serves the examples at **http://127.0.0.1:3000**.

Each example includes a toolbar with demo buttons (Insert, Update, Delete
actions) powered by the proxy's `POST /api/demo` endpoint. No psql session
needed for basic interaction.

For advanced usage, open a psql session and run demo commands directly:

```bash
docker compose exec db psql -U postgres -d pg_reactive_test
```

## Manual Setup (Alternative)

If you prefer using the root docker-compose:

```bash
# From the project root
docker compose up -d --build

# Run all setup scripts (glob handles all 12 examples automatically)
for f in /examples/*/setup.sql; do
  docker compose exec -T db psql -U postgres -d pg_reactive_test -f "$f"
done
```

Then open any `app.html` in your browser and run the demo SQL commands from
a psql session.

## The Examples

| # | Name | SQL Constructs | What It Proves |
|---|------|---------------|----------------|
| 1 | **Live Product Catalog** | `WHERE` | Basic setup, simplest possible live query |
| 2 | **Order Feed** | `JOIN x3` | Multi-table tracking -- CDC tools can't do this |
| 3 | **Revenue Dashboard** | `LEFT JOIN + GROUP BY + SUM` | Live aggregates -- neither CDC nor Hasura can express this |
| 4 | **Category Leaderboard** | `HAVING + RANK() OVER` | Advanced SQL -- pg_ivm also fails on these |
| 5 | **Real-Time CRM** | `CTE + LIMIT + Multi-Query` | Full dashboard with 3 simultaneous subscriptions |
| 6 | **Inventory Monitor** | `CASE + JOIN` | Computed status columns, conditional logic in live queries |
| 7 | **Multi-Filter Dashboard** | `3x WHERE` | Multiple subscriptions on same table with different filters |
| 8 | **Order Analytics** | `date_trunc + GROUP BY` | Time-bucketed aggregates, temporal analysis |
| 9 | **Price Comparison** | `RANK, NTILE, ratio` | Window functions: ranking, quartiles, ratios to avg/max |
| 10 | **Executive Scorecard** | `COUNT DISTINCT, SUM, AVG, NULLIF` | Single-row aggregate KPIs, dashboard metrics |
| 11 | **Notify Mode vs Delta** | `subscribe(..., 'notify')` | Lightweight invalidation (~50B) vs full diffs side-by-side |
| 12 | **Tutorial Console** | All of the above | 15-step interactive walkthrough of every feature |

## How It Works

Each example connects directly to the pg_reactive WebSocket proxy:

```
Browser  --ws://127.0.0.1:8080/ws/{query_id}-->  Rust Proxy  --LISTEN pgr-->  PostgreSQL
```

When you run DML (INSERT/UPDATE/DELETE) in psql, the pg_reactive extension:
1. Detects which subscriptions are affected (via AFTER STATEMENT triggers)
2. **Delta mode** (default): Recomputes the query using EXCEPT to find exact delta (inserted/deleted rows)
   **Notify mode**: Sends a lightweight `{"type":"invalidated"}` signal (~50 bytes) without re-executing the query
3. Sends the result as JSON via pg_notify
4. The proxy fans it out to all connected WebSocket clients

## Architecture

```
+-------------------------+     +--------------+     +-------------+
|     PostgreSQL 16       |     |  Rust Proxy  |     |   Browser   |
|  +-------------------+  |     |  (WebSocket) |     |  (app.html) |
|  |    pg_reactive     |  |     |              |     |             |
|  |  EXCEPT-based delta|-->--->-|  LISTEN pgr  |-->--|  ws://...   |
|  |  pg_notify('pgr')  |  |     |  broadcast   |     |  live UI    |
|  +-------------------+  |     +--------------+     +-------------+
+-------------------------+
```

## Cleanup

```bash
# Stop all services
cd examples
docker compose down
```

To unsubscribe individual queries (without stopping):

```sql
SELECT pgr.unsubscribe('electronics');
SELECT pgr.unsubscribe('order_feed');
SELECT pgr.unsubscribe('revenue_by_customer');
SELECT pgr.unsubscribe('premium_categories');
SELECT pgr.unsubscribe('product_rankings');
SELECT pgr.unsubscribe('top_customers');
SELECT pgr.unsubscribe('recent_orders');
SELECT pgr.unsubscribe('revenue_by_region');
SELECT pgr.unsubscribe('inventory_status');
SELECT pgr.unsubscribe('budget_products');
SELECT pgr.unsubscribe('midrange_products');
SELECT pgr.unsubscribe('premium_products');
SELECT pgr.unsubscribe('hourly_orders');
SELECT pgr.unsubscribe('price_matrix');
SELECT pgr.unsubscribe('exec_kpis');
SELECT pgr.unsubscribe('sensor_notify');
SELECT pgr.unsubscribe('sensor_delta');
-- Tutorial (12) subs are created/cleaned interactively
```
