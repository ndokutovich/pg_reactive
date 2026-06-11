---
title: PL/v8 Runtime
sidebar_position: 3
description: Run JavaScript inside PostgreSQL with full ACID transaction support.
---

# PL/v8 Runtime

PL/v8 functions run JavaScript directly inside PostgreSQL using the [PL/v8 extension](https://plv8.github.io/). They execute within the database transaction, giving you full ACID guarantees.

## When to use PL/v8

- Data-heavy operations that benefit from running close to the data
- Functions that need transactional consistency with other database operations
- Logic that doesn't need external API calls

## Creating a PL/v8 function

PL/v8 edge functions follow the naming convention `pgstack.fn_{name}(body jsonb)`:

```sql
CREATE OR REPLACE FUNCTION pgstack.fn_process_order(body jsonb)
RETURNS jsonb AS $$
  const orderId = body.order_id;
  const items = body.items;

  // Use plv8.execute for SQL queries
  const order = plv8.execute(
    'SELECT * FROM orders WHERE id = $1', [orderId]
  )[0];

  let total = 0;
  for (const item of items) {
    plv8.execute(
      'INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)',
      [orderId, item.product_id, item.quantity]
    );
    total += item.price * item.quantity;
  }

  plv8.execute(
    'UPDATE orders SET total = $1, status = $2 WHERE id = $3',
    [total, 'confirmed', orderId]
  );

  return { success: true, total: total };
$$ LANGUAGE plv8;
```

## Deploy

```bash
pgstack functions deploy process_order --runtime plv8
```

The function name must match the SQL function suffix exactly — invoking `/functions/v1/process_order` makes the proxy call `pgstack.fn_process_order`.

Prerequisites: `SERVICE_ROLE_KEY` must be set (env or `--service-role-key`), and `supabase/functions/process_order/index.ts` must exist — the CLI reads it into the `code` column even for plv8 (create it with `pgstack functions new process_order`; execution still uses the `pgstack.fn_process_order` SQL function, not that file). Alternatively, register directly in SQL:

```sql
INSERT INTO pgstack.edge_functions (name, runtime)
VALUES ('process_order', 'plv8')
ON CONFLICT (name) DO UPDATE SET runtime = EXCLUDED.runtime, status = 'active';
```

## Invoke

```bash
curl -X POST http://127.0.0.1:8080/functions/v1/process_order \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"order_id": 1, "items": [{"product_id": 5, "quantity": 2, "price": 9.99}]}'
```

The proxy wraps the call in an RLS transaction, so Row Level Security policies apply.

## Limitations

- No `fetch()` — cannot call external APIs
- JavaScript only (no TypeScript)
- Requires the `plv8` PostgreSQL extension installed
- Code runs synchronously inside the database
