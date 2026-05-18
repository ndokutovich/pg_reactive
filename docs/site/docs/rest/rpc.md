---
title: RPC (Stored Functions)
sidebar_position: 4
description: Call PostgreSQL functions via the pgStack REST API using /rest/v1/rpc/.
---

# RPC (Stored Functions)

The RPC endpoint lets you call PostgreSQL functions via HTTP. This is useful for complex business logic that runs inside the database — aggregations, multi-step transactions, computed values, etc.

## Basic usage

```bash
# Call a function with POST (parameters as JSON body)
POST /rest/v1/rpc/function_name
Content-Type: application/json
Authorization: Bearer <token>

{"param1": "value1", "param2": 42}
```

```bash
# Call a function with GET (parameters as query string)
GET /rest/v1/rpc/function_name?param1=value1&param2=42
```

## Creating functions

Write PostgreSQL functions in SQL or PL/pgSQL:

```sql
-- Simple scalar function
CREATE OR REPLACE FUNCTION get_order_total(p_order_id BIGINT)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(quantity * unit_price), 0)
  FROM order_items
  WHERE order_id = p_order_id;
$$ LANGUAGE sql STABLE SECURITY INVOKER;
```

Call it:

```bash
POST /rest/v1/rpc/get_order_total
{"p_order_id": 42}
```

Response:

```json
149.99
```

## Returning rows

Functions that return `SETOF` a table type or composite type return JSON arrays:

```sql
CREATE OR REPLACE FUNCTION get_recent_orders(p_limit INT DEFAULT 10)
RETURNS SETOF orders AS $$
  SELECT * FROM orders
  ORDER BY created_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY INVOKER;
```

```bash
POST /rest/v1/rpc/get_recent_orders
{"p_limit": 5}
```

Response:

```json
[
  {"id": 10, "status": "pending", "amount": 29.99, "created_at": "2025-01-14T..."},
  {"id": 9, "status": "shipped", "amount": 149.99, "created_at": "2025-01-13T..."}
]
```

## Returning JSON

Functions can return `json` or `jsonb` directly:

```sql
-- SECURITY DEFINER + pinned search_path (audit hardening): pg_catalog
-- + pg_temp only. Every app object is fully qualified (public.orders)
-- so a CREATE-on-public role cannot shadow the table or jsonb_build_object
-- and run code as the definer. The bootstrap default-denies PUBLIC
-- EXECUTE, so GRANT EXECUTE is explicit.
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'total_orders',   (SELECT count(*) FROM public.orders),
    'pending_orders', (SELECT count(*) FROM public.orders WHERE status = 'pending'),
    'revenue_today',  (
      SELECT COALESCE(SUM(amount), 0)
      FROM public.orders
      WHERE created_at >= CURRENT_DATE
        AND status != 'cancelled'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
```

```bash
POST /rest/v1/rpc/get_dashboard_stats
```

Response:

```json
{"total_orders": 1042, "pending_orders": 17, "revenue_today": 3299.50}
```

## Security: INVOKER vs DEFINER

`SECURITY INVOKER` (default) runs the function as the calling role (`anon` or `authenticated`). RLS applies to all queries inside the function.

`SECURITY DEFINER` runs the function as its owner (typically `postgres`). Use this carefully — it bypasses RLS. Common use cases: reading from tables the user doesn't have direct access to, or performing admin operations that are safe to expose.

Every `SECURITY DEFINER` function in this codebase ships with two
required hardenings:

1. **Pinned `search_path`** — `SET search_path = pg_catalog, pg_temp`
   prevents a role with `CREATE` on `public` from shadowing
   `auth.uid` / `format` / your application tables and running code
   as the definer.
2. **Fully-qualified references** — write `public.orders`, not bare
   `orders`. The pinned `search_path` removes `public` from the
   lookup chain, so unqualified refs would error at runtime.
3. **Explicit `GRANT EXECUTE`** — the bootstrap revokes the PostgreSQL
   default of `PUBLIC EXECUTE` on functions in `public`. Any function
   you want callable via `/rest/v1/rpc` needs an explicit grant.

```sql
-- Safe: reads system stats, no user data
CREATE OR REPLACE FUNCTION public.app_version()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT '1.0.0';
$$;

GRANT EXECUTE ON FUNCTION public.app_version() TO anon, authenticated;
```

## SDK usage

```typescript
// POST (default)
const { data, error } = await pgstack.rpc('get_order_total', {
  p_order_id: 42,
});

// GET
const { data, error } = await pgstack.rpc('get_dashboard_stats', {}, { get: true });

// With typed return value
interface Stats {
  total_orders: number;
  pending_orders: number;
  revenue_today: number;
}

const { data } = await pgstack.rpc('get_dashboard_stats') as { data: Stats | null; error: unknown };
```

## React hook

```tsx
import { useRpc } from '@pgstack/sdk/react';

function Dashboard() {
  const { data, loading, error, refetch } = useRpc<Stats>(
    pgstack,
    'get_dashboard_stats',
  );

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <div>
      <p>Total orders: {data?.total_orders}</p>
      <p>Revenue today: ${data?.revenue_today?.toFixed(2)}</p>
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}
```

## Mutations via RPC

Functions that modify data should use `VOLATILE` (the default):

```sql
CREATE OR REPLACE FUNCTION cancel_order(p_order_id BIGINT)
RETURNS orders AS $$
DECLARE
  v_order orders;
BEGIN
  UPDATE orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id
    AND user_id = auth.uid()  -- RLS-style check
    AND status NOT IN ('shipped', 'delivered')
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found or cannot be cancelled';
  END IF;

  RETURN v_order;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
```

```typescript
const { data, error } = await pgstack.rpc('cancel_order', { p_order_id: 42 });
if (error) {
  console.error('Cancel failed:', error.message);
} else {
  console.log('Cancelled order:', data);
}
```

## Error handling

PostgreSQL exceptions are returned as HTTP 400 with an error message:

```json
{"error": "Order not found or cannot be cancelled"}
```

Use `RAISE EXCEPTION` to return user-facing error messages from your functions.

## Granting access

Functions are owned by `postgres` by default. Grant execute permission to the relevant roles:

```sql
-- Allow authenticated users to call this function
GRANT EXECUTE ON FUNCTION get_order_total(BIGINT) TO authenticated;

-- Allow anonymous users
GRANT EXECUTE ON FUNCTION app_version() TO anon;
```
