---
title: Embedding (FK Joins)
sidebar_position: 3
description: Fetch related rows via foreign keys using the select parameter.
---

# Embedding (FK Joins)

Embedding lets you fetch related rows from joined tables in a single request by traversing foreign key relationships. The syntax uses parentheses in the `select` parameter.

:::info Implementation Status
Basic embedding support is planned. The examples on this page describe the intended API compatible with PostgREST.
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

Apply filters to the embedded table using dot notation:

```bash
# Orders for customers in New York
GET /rest/v1/orders?select=id,status,customers(name,city)&customers.city=eq.New York
```

## Limiting embedded results

```bash
# Each customer's 3 most recent orders
GET /rest/v1/customers?select=name,orders(id,status)&orders.limit=3&orders.order=created_at.desc
```

## Counting related rows

```bash
# Customers with order count
GET /rest/v1/customers?select=name,orders(count)
```

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
