---
title: Query Support
sidebar_position: 4
description: Which SELECT shapes pg_reactive can subscribe to, with a runnable example for each and the limits you need to plan around.
---

# Query Support

pg_reactive subscribes at the **query level**. You hand [`pgr.subscribe`](./subscribe.md) a `SELECT`, and from then on you receive a delta whenever the *result set* of that `SELECT` changes — not a raw stream of every row mutation on the underlying tables. If you subscribe to `SELECT * FROM orders WHERE status = 'active'`, an UPDATE that flips an order to `active` produces an `inserted` row; an UPDATE to a column you never selected produces nothing at all.

The rule of thumb is simple: **if PostgreSQL can parse and execute the `SELECT`, pg_reactive can subscribe to it.** The diff engine is built on SQL `EXCEPT` against a stored snapshot, so the only hard requirements are that the query is a `SELECT` and that its result rows compare cleanly under `EXCEPT`. Everything else — joins, aggregates, window functions, CTEs — is just SQL the extension re-runs for you.

This page walks each supported class with a runnable example, explains column-level tracking, and states the limits honestly.

## How a subscription decides what to send

Before the catalog of supported shapes, it helps to know the mechanism — it explains every "supported" and every "limitation" below.

On `pgr.subscribe`, the extension:

1. Parses your `SELECT` with PostgreSQL's own parser and walks the tree to find every referenced **table OID** and, per table, a **column bitmask** of the columns your query touches (SELECT list, `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY`, …).
2. Materializes the current result into an UNLOGGED snapshot table, `pgr._snap_<query_id>`.
3. Installs `AFTER STATEMENT` triggers on each dependent table — `INSERT`/`DELETE` triggers shared across subscriptions, plus a **per-query `UPDATE` trigger** scoped with `AFTER UPDATE OF <tracked columns>` so it only fires for columns your query actually reads.

When a tracked DML statement runs, the trigger re-executes your `SELECT` **once** into a temp table, then computes two `EXCEPT` diffs against the snapshot — `snapshot EXCEPT new` (deleted rows) and `new EXCEPT snapshot` (inserted rows) — replaces the snapshot, and emits the delta via `NOTIFY` on the `pgr` channel. See [Architecture](./architecture.md) for the full lifecycle and [Wire Format](./wire-format.md) for the JSON shape.

Two consequences fall directly out of this design:

- **Any `SELECT` works**, because the engine never reasons about your query semantics — it just runs the SQL and diffs the rows.
- **Result-set size is the cost driver**, because the `EXCEPT` runs over the whole result on every triggering statement (see [Limits](#limits-and-when-to-reconsider)).

## Supported query shapes

The table below is the canonical list of shapes the extension supports. Runnable examples for the headline classes follow.

| Category | Examples |
|----------|----------|
| **Basic** | `SELECT`, `WHERE`, `ORDER BY`, `LIMIT` / `OFFSET`, `DISTINCT` |
| **Joins** | `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN` |
| **Aggregates** | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `array_agg`, `string_agg` |
| **Grouping** | `GROUP BY`, `HAVING` |
| **Subqueries** | scalar subqueries, `IN (SELECT …)`, `EXISTS (SELECT …)` |
| **CTEs** | `WITH … AS (SELECT …)`, `WITH RECURSIVE` |
| **Lateral** | `LATERAL JOIN`, `LATERAL (SELECT …)` |
| **Window functions** | `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `LEAD()`, `LAG()`, `NTILE()` |
| **Expressions** | `CASE WHEN`, `COALESCE`, `NULLIF`, type casts |
| **Set operations** | `UNION`, `INTERSECT`, `EXCEPT` *(inside your own query)* |

Each example below registers a subscription as a privileged admin role. In production, expose subscription registration to app clients through `SECURITY DEFINER` wrappers, never by granting `pgr.subscribe` directly — see [Security Model](./security-model.md).

### Filtered select (WHERE)

The bread-and-butter case. You only get deltas when a row enters or leaves the filtered set.

```sql
SELECT pgr.subscribe(
  'active_orders',
  $$ SELECT id, total, status FROM orders WHERE status = 'active' $$
);
```

`INSERT`ing an `active` order yields one `inserted` row. Flipping an order from `active` to `shipped` yields one `deleted` row (it left the set). Flipping a `pending` order *to* `active` yields one `inserted` row. A `DELETE` of a row that was never `active` yields nothing — the result set did not change.

### ORDER BY and LIMIT (top-N)

`ORDER BY` and `LIMIT` are supported, and they make the subscription a live "top-N" view: as rows shuffle in or out of the top slice, you get inserted/deleted deltas for exactly the rows that crossed the boundary.

```sql
SELECT pgr.subscribe(
  'leaderboard',
  $$ SELECT player, score FROM scores ORDER BY score DESC LIMIT 10 $$
);
```

A new high score that pushes its way into the top 10 produces an `inserted` row for it and a `deleted` row for whoever fell off — the diff captures both ends of the boundary swap.

### DISTINCT

`DISTINCT` is supported; the deduplicated result set is what gets diffed.

```sql
SELECT pgr.subscribe(
  'active_countries',
  $$ SELECT DISTINCT country FROM customers WHERE active $$
);
```

Adding the 50th customer from a country already in the set produces no delta — the distinct result is unchanged. Adding the first customer from a new country produces one `inserted` row.

### Multi-table JOIN

Joins are first-class. pg_reactive extracts every referenced table and installs triggers on **all** of them, so a change to *either* side of the join recomputes the result.

```sql
SELECT pgr.subscribe(
  'customer_items',
  $$ SELECT c.name, i.item
     FROM items i
     JOIN customers c ON c.id = i.customer_id $$
);
```

This is the `va_cross` scenario in the extension's `validate_article.mjs` regression suite: renaming a customer (a change on the `customers` side) produces a `deleted` row carrying the old joined value `{name: "Bob", item: "Widget"}` and an `inserted` row carrying the new one `{name: "Robert", item: "Widget"}`. The join is re-evaluated and the diff reflects the joined output, not the base-table edit.

### LEFT JOIN

Outer joins behave exactly as the SQL does — unmatched rows appear with `NULL` on the outer side, and the diff tracks them.

```sql
SELECT pgr.subscribe(
  'dept_roster',
  $$ SELECT d.name AS dept, e.name AS emp
     FROM depts d
     LEFT JOIN emps e ON e.dept_id = d.id
     ORDER BY d.id, e.id $$
);
```

A department with no employees shows up as `{dept: "Research", emp: null}`. Hiring the first employee into it produces a `deleted` row for the `null` placeholder and an `inserted` row for the now-matched pair — the standard LEFT-JOIN transition, delivered as a delta.

### GROUP BY with aggregates

Aggregates are where query-level subscriptions earn their keep: you subscribe to a rolled-up result and receive deltas on the *aggregate rows*, not the underlying mutations.

```sql
SELECT pgr.subscribe(
  'orders_by_status',
  $$ SELECT status, COUNT(*) AS cnt, SUM(amount) AS total
     FROM orders
     GROUP BY status $$
);
```

`INSERT`ing one `active` order does **not** send you that order — it sends a `deleted` row for the old `{status: "active", cnt: 5, total: 500}` and an `inserted` row for the new `{status: "active", cnt: 6, total: 600}`. The client applies the diff and the aggregate value updates in place. `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `array_agg`, and `string_agg` all work the same way.

### HAVING

`HAVING` filters groups, and the subscription tracks groups crossing the threshold.

```sql
SELECT pgr.subscribe(
  'popular_tags',
  $$ SELECT tag, COUNT(*) AS cnt
     FROM tags
     GROUP BY tag
     HAVING COUNT(*) > 1 $$
);
```

A tag with a single use is absent from the result. Inserting a second row with that tag crosses `HAVING COUNT(*) > 1`, and the group appears as an `inserted` row `{tag: "go", cnt: 2}`. Drop back below the threshold and it leaves as a `deleted` row.

### Window functions

Window functions are supported. Because a window result depends on the *whole partition*, a single row change can re-rank many rows — and the diff captures every row whose windowed output moved.

```sql
SELECT pgr.subscribe(
  'price_ranking',
  $$ SELECT id, name, price,
            RANK() OVER (ORDER BY price DESC) AS rnk
     FROM products $$
);
```

Insert a new most-expensive product and you get an `inserted` row at `rnk = 1` **plus** `deleted`/`inserted` pairs for every product whose rank shifted down. `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LEAD`, `LAG`, and `NTILE` are all supported — keep partitions modest, since a re-rank diffs the affected rows.

### Subqueries, CTEs, LATERAL, and set operations

These parse and execute like any other `SELECT`, so they subscribe without ceremony. A couple of shapes:

```sql
-- CTE
SELECT pgr.subscribe(
  'recent_big_orders',
  $$ WITH big AS (
       SELECT id, total FROM orders WHERE total > 1000
     )
     SELECT * FROM big ORDER BY total DESC $$
);

-- EXISTS subquery
SELECT pgr.subscribe(
  'customers_with_orders',
  $$ SELECT c.id, c.name
     FROM customers c
     WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) $$
);
```

The extension installs triggers on every table the query references (subject to the [16-table limit](#limits-and-when-to-reconsider)), so a change to a table named only inside a subquery or CTE still recomputes the result.

## Column-level tracking

This is the feature that keeps subscriptions cheap and is worth understanding precisely.

When you subscribe, pg_reactive records a per-table bitmask of the columns your query actually reads. The per-query `UPDATE` trigger is created as `AFTER UPDATE OF <those columns>`, so **PostgreSQL itself never fires the trigger for an UPDATE that touches only columns outside your query.** No trigger fire means no recompute and no notification.

```sql
SELECT pgr.subscribe(
  'name_list',
  $$ SELECT id, name FROM coltrack $$
);
```

With this subscription live:

- `UPDATE coltrack SET extra_notes = 'x' WHERE id = 1;` → **no delta.** `extra_notes` is not in the SELECT, so the `AFTER UPDATE OF id, name` trigger does not fire.
- `UPDATE coltrack SET name = 'Renamed' WHERE id = 1;` → **one `deleted` + one `inserted`** row, reflecting the old and new `(id, name)` pair.

This is the `va_col` scenario in the regression suite, and it is the concrete payoff of subscribing at the query level rather than streaming raw row changes: writes to columns nobody is watching cost a subscription nothing.

Two boundary cases to keep in mind:

- **`SELECT *` watches every column.** A `*` query sets the all-columns mask, so any UPDATE on the table can fire the trigger. Select the columns you actually need if you want columns outside that set to stay silent.
- **`INSERT` and `DELETE` always recompute.** Column-level skipping applies only to `UPDATE` (the engine can't know whether an inserted/deleted row enters or leaves your result without re-running the query). Inserts and deletes on a dependent table always trigger a recompute.

## Limits and when to reconsider

pg_reactive will subscribe to almost any `SELECT`, but the diff engine has a cost model and hard caps. Plan around these.

### Hard limits

| Limit | Value | Source |
|-------|-------|--------|
| Dependent tables per subscription | 16 | `PGR_MAX_DEPS_PER_QUERY` |
| Tracked columns per table | 64 | `uint64` column bitmask |
| Query text length | 2048 characters | `PGR_QUERY_TEXT_LEN` |
| Query ID | 64 characters, `[A-Za-z0-9_-]` | hash key |
| NOTIFY delta payload | ~7897 bytes for the default `pgr` channel | `8000 − len(channel) − 100` |

A query that references more than 16 tables, or reads more than 64 columns of one table, cannot be subscribed. The query text itself must fit in 2048 characters.

### Result-set size drives latency and overflow

The `EXCEPT` diff runs over the **entire result set** on every triggering statement, so latency scales with result size, not with the size of the change:

| Result set | EXCEPT p50 |
|------------|-----------|
| 1K rows | 2.8 ms |
| 10K rows | 18.5 ms |
| 100K rows | 263 ms |

A 100K-row live query recomputes in ~263 ms *per write* to a dependent table — fine for a dashboard that changes occasionally, painful for a hot table. Keep subscribed queries selective: index the filter columns, and prefer `WHERE`/`LIMIT` to subscribing to whole tables.

When the serialized delta JSON exceeds the payload limit (~7897 bytes on the default channel), pg_reactive does **not** send the rows. Instead it sends an [overflow signal](./wire-format.md#overflow) and the client must clear its local snapshot and re-fetch the full result. An overflow is also emitted when the snapshot's column layout drifts from the query (e.g. after `ALTER TABLE` on a watched table). Treat `overflow` as a generic "re-fetch now" instruction. Large or churny result sets will trip this often — another reason to keep result sets small.

### Not supported

- **Anything that isn't a `SELECT`.** `pgr.subscribe` stores and re-executes the text as a query; DML, DDL, or procedural statements are out of scope.
- **Result rows that don't compare cleanly under `EXCEPT`.** The diff relies on `EXCEPT`, which requires the result columns to be of comparable types. A `SELECT` projecting a column of a type without an equality/sort operator can't be diffed.

For high-churn or very large queries where a full snapshot diff is impractical, use **`notify` mode** instead of the default `delta` mode. In `notify` mode the extension skips the snapshot and `EXCEPT` entirely and emits a bare `{"type":"invalidated","query_id":"…","seq":N}` signal on every change; the client re-fetches the result on its own schedule. You trade row-level deltas for a much cheaper "something changed" hint. See [Subscribe](./subscribe.md) for mode selection and [Wire Format](./wire-format.md) for the invalidation message.

## Verifying support yourself

The shapes documented here are exercised by the extension's `validate_article.mjs` regression suite — GROUP BY + SUM, `RANK()` window, `HAVING`, LEFT JOIN, column tracking, and cross-table JOIN each have a dedicated check. The fastest way to confirm a query of your own is supported is to subscribe to it and watch for the `{"status":"subscribed",...}` JSON return, then issue a write and observe the delta. If you use the pgStack umbrella, the [Quickstart](/quickstart) gets a proxy and SDK wired up in a few minutes so you can watch deltas arrive in the browser.

## Next steps

- [Subscribe](./subscribe.md) — register a query, choose `delta` vs `notify` mode, and bind an audience
- [Wire Format](./wire-format.md) — the exact JSON of deltas, overflow, and invalidation messages
- [Architecture](./architecture.md) — how the snapshot/trigger/EXCEPT pipeline fits together
- [Security Model](./security-model.md) — why `pgr.subscribe` is a privileged API and how to expose it safely
