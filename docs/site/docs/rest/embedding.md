---
title: Embedding (FK Joins)
sidebar_position: 3
description: Fetch related rows via foreign keys using the select parameter.
---

# Embedding (FK Joins)

Embedding lets you fetch related rows from joined tables in a single request by traversing foreign key relationships. The syntax uses parentheses in the `select` parameter.

:::info Implementation Status
Embedding is implemented for foreign-key relationships (many-to-one and one-to-many), up to 3 levels of nesting. Filters, ordering, limits, and counts on embedded relations are not yet supported.
:::

## Basic embedding

Embed a related table by naming it in `select`:

```bash
# Fetch orders with their customer's name and email
GET /rest/v1/orders?select=id,status,amount,customers(name,email)
```

Response:

```json
[
  {
    "id": 1,
    "status": "shipped",
    "amount": 149.99,
    "customers": {
      "name": "Jane Doe",
      "email": "jane@example.com"
    }
  }
]
```

The foreign key must exist in PostgreSQL for embedding to work:

```sql
CREATE TABLE customers (
  id    BIGSERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  status      TEXT NOT NULL,
  amount      NUMERIC(10,2)
);
```

## Selecting embedded columns

```bash
# Only fetch specific columns from the embedded table
GET /rest/v1/orders?select=id,status,customers(id,name)

# Fetch all columns from the embedded table
GET /rest/v1/orders?select=id,status,customers(*)
```

## Reverse embedding (one-to-many)

Embed the "many" side of a relationship:

```bash
# Fetch customers with all their orders
GET /rest/v1/customers?select=*,orders(id,status,amount)
```

Response:

```json
[
  {
    "id": 1,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "orders": [
      {"id": 1, "status": "shipped", "amount": 149.99},
      {"id": 5, "status": "pending", "amount": 29.99}
    ]
  }
]
```

## Deep embedding

Embed multiple levels deep:

```bash
# Orders → order items → products
GET /rest/v1/orders?select=id,status,order_items(quantity,products(name,sku))
```

Nesting is limited to 3 levels. Deeper embeds are rejected with HTTP 400 (`"invalid embed in request"`).

## Multiple embeds

```bash
# Orders with both customer info and shipping address
GET /rest/v1/orders?select=id,status,customers(name),shipping_addresses(street,city,country)
```

## SDK usage

```typescript
// Embed a related table
const { data } = await pgstack.from('orders')
  .select('id, status, customers(name, email)');

// Embed with filters on the parent
const { data } = await pgstack.from('orders')
  .select('id, status, amount, customers(name)')
  .eq('status', 'pending')
  .order('created_at', { ascending: false });

// Reverse embed
const { data } = await pgstack.from('customers')
  .select('*, orders(id, status, amount)')
  .eq('id', customerId)
  .single();
```

## TypeScript types for embedded results

After generating types, embedded results are automatically typed:

```typescript
import type { Database } from './types/database';

type OrderWithCustomer = Database['public']['Tables']['orders']['Row'] & {
  customers: Pick<Database['public']['Tables']['customers']['Row'], 'name' | 'email'>;
};

const { data } = await pgstack.from<OrderWithCustomer>('orders')
  .select('*, customers(name, email)');
```

## Filtering embedded results

Not yet supported. Dotted filter keys such as `customers.city=eq.New York` are treated as a column filter on the top-level table and rejected with HTTP 400 (`"unknown column in request"`). Filters currently apply only to the top-level table.

## Limiting embedded results

Not yet supported. `orders.limit=3` is parsed as a filter on a literal column named `orders.limit` (HTTP 400 `"unknown column in request"`), and `orders.order=created_at.desc` fails operator parsing. One-to-many embeds always return all matching rows.

## Counting related rows

Not yet supported. `orders(count)` is interpreted as a request for a column named `count` on the `orders` table and rejected with HTTP 400 (`"invalid embed in request"`). There is no aggregate/count embed feature; use `Prefer: count=exact` on a separate request against the related table.

## Schema requirements

Embedding works by following PostgreSQL foreign key constraints. Make sure:

1. The FK constraint exists in the database (not just enforced in application code)
2. The authenticated role has SELECT permission on both tables
3. RLS policies allow reading the related rows

```sql
-- Grant SELECT to authenticated role
GRANT SELECT ON customers TO authenticated;
GRANT SELECT ON orders TO authenticated;
```
