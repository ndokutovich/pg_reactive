---
title: Pagination
sidebar_position: 5
description: Offset and cursor-based pagination for pgStack REST API queries.
---

# Pagination

pgStack supports offset-based pagination out of the box. Cursor-based pagination can be implemented using filters and ordering.

## Offset pagination

Use `limit` and `offset` query parameters:

```bash
# Page 1: first 20 rows
GET /rest/v1/orders?order=created_at.desc&limit=20&offset=0

# Page 2: next 20 rows
GET /rest/v1/orders?order=created_at.desc&limit=20&offset=20

# Page 3
GET /rest/v1/orders?order=created_at.desc&limit=20&offset=40
```

SDK:

```typescript
const PAGE_SIZE = 20;
const page = 2; // 0-indexed

const { data, error } = await pgstack.from('orders')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(PAGE_SIZE)
  .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
```

The `.range(from, to)` method sets both `offset` and `limit`:

```typescript
// Range is inclusive: range(0, 19) returns rows 1-20
await pgstack.from('orders').select('*').range(0, 19);   // rows 1-20
await pgstack.from('orders').select('*').range(20, 39);  // rows 21-40
```

## Getting total count

To implement page controls you need the total row count. Use `select` with `count: 'exact'`:

```typescript
const { data, count, error } = await pgstack.from('orders')
  .select('*', { count: 'exact' })
  .order('created_at', { ascending: false })
  .range(0, 19);

console.log('Total rows:', count);
console.log('Page data:', data);
```

This issues a `SELECT COUNT(*) ...` alongside your query and returns both results.

## React pagination example

```tsx
import { useState } from 'react';
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');
const PAGE_SIZE = 10;

function OrdersTable() {
  const [page, setPage] = useState(0);
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  async function loadPage(p: number) {
    setLoading(true);
    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, count } = await pgstack
      .from('orders')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    setOrders(data ?? []);
    setTotal(count ?? 0);
    setPage(p);
    setLoading(false);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      {loading ? <p>Loading...</p> : (
        <table>
          <tbody>
            {orders.map((order: Record<string, unknown>) => (
              <tr key={String(order.id)}>
                <td>{String(order.id)}</td>
                <td>{String(order.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <button disabled={page === 0} onClick={() => loadPage(page - 1)}>Previous</button>
        <span>Page {page + 1} of {totalPages}</span>
        <button disabled={page >= totalPages - 1} onClick={() => loadPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
```

## Cursor pagination

Cursor pagination is more efficient for large datasets and avoids the "page drift" problem (where rows inserted between page loads can cause duplicates or skips).

Implement it using ordered filtering:

```bash
# First page: get the first 20 rows
GET /rest/v1/orders?order=id.asc&limit=20

# Next page: get rows after the last seen ID
GET /rest/v1/orders?order=id.asc&limit=20&id=gt.{last_id}
```

SDK:

```typescript
async function fetchNextPage(lastId?: number) {
  let query = pgstack.from('orders')
    .select('*')
    .order('id', { ascending: true })
    .limit(20);

  if (lastId !== undefined) {
    query = query.gt('id', lastId);
  }

  const { data } = await query;
  return data;
}

// First page
const page1 = await fetchNextPage();

// Next page (after last item of page1)
const lastId = page1?.[page1.length - 1]?.id as number;
const page2 = await fetchNextPage(lastId);
```

For timestamp-based cursors with potential duplicates, combine two columns:

```bash
# Rows after a specific timestamp+id pair (stable ordering)
GET /rest/v1/orders?order=created_at.desc,id.desc&created_at=lt.2025-01-14T00:00:00Z&limit=20
```

## Default limit

If no `limit` is specified, pgStack defaults to returning up to 1000 rows. Always specify a limit for production queries to avoid large payloads.

```typescript
// Bad: may return thousands of rows
const { data } = await pgstack.from('orders').select('*');

// Good: explicit limit
const { data } = await pgstack.from('orders').select('*').limit(50);
```
