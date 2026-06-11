---
title: Transaction Batching
sidebar_position: 6
description: Execute multiple REST operations in a single database transaction with cross-operation references.
---

# Transaction Batching

Execute multiple REST operations in a single PostgreSQL transaction via `POST /rest/v1/batch`. Operations can reference results from previous steps using `{{opId.field}}` templates.

This is a pgStack exclusive — Supabase does not offer multi-statement transaction batching.

## Basic usage

```bash
POST /rest/v1/batch
Authorization: Bearer <token>
Content-Type: application/json

{
  "atomic": true,
  "operations": [
    { "id": "order", "method": "POST", "path": "/rest/v1/orders",
      "body": { "customer_id": 42, "total": 99.99 } },
    { "id": "item",  "method": "POST", "path": "/rest/v1/order_items",
      "body": { "order_id": "{{order.id}}", "product_id": 7, "quantity": 2 } },
    { "id": "confirm", "method": "PATCH", "path": "/rest/v1/orders",
      "query": "id=eq.{{order.id}}", "body": { "status": "confirmed" } }
  ]
}
```

## SDK usage

```typescript
const { data, error } = await client.batch([
  { id: 'order', method: 'POST', path: '/rest/v1/orders',
    body: { customer_id: 42, total: 99.99 } },
  { id: 'item', method: 'POST', path: '/rest/v1/order_items',
    body: { order_id: '{{order.id}}', product_id: 7 } },
], { atomic: true });

// data.results[0].data.id → the new order ID
// data.results[1].data.order_id → same ID (template resolved)
```

## Template resolution

Use `{{opId.field}}` to reference a previous operation's result:

| Template | Description |
|----------|-------------|
| `{{order.id}}` | Extract `id` from operation "order"'s result |
| `{{items.0.id}}` | Extract `id` from first element if result is an array |
| `{{items.*.id}}` | Wildcard: comma-separated `id` from every element of an array result — designed for in-filters like `?id=in.({{items.*.id}})` |
| `{{order.nested.field}}` | Dot-path navigation into nested objects |

Templates work in both `body` (JSON) and `query` (URL query string) fields. References are resolved sequentially — each operation can only reference operations that ran before it.

## Error handling modes

### Atomic mode (default)

```json
{ "atomic": true }
```

All operations run in a single PostgreSQL transaction. If **any** operation fails, the entire transaction is rolled back and no changes persist.

- **Success**: HTTP 200 with all results
- **Failure**: HTTP 422 with results up to the failed operation, plus `error` and `failed_operation` fields

```json
{
  "results": [
    { "id": "order", "status": 201, "data": { "id": 123 } },
    { "id": "item",  "status": 409, "error": "duplicate value violates unique constraint" }
  ],
  "error": "operation item failed: duplicate value violates unique constraint",
  "failed_operation": "item"
}
```

### Partial mode

```json
{ "atomic": false }
```

Each operation gets its own `SAVEPOINT`. Failed operations are rolled back individually while successful ones persist.

- **All succeed**: HTTP 200
- **Some fail**: HTTP 207 (Multi-Status) — check each result's `status` and `error`

```json
{
  "results": [
    { "id": "op0", "status": 201, "data": { "id": 1 } },
    { "id": "op1", "status": 500, "error": "internal database error" },
    { "id": "op2", "status": 201, "data": { "id": 2 } }
  ]
}
```

## Supported operations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rest/v1/{table}` | Select with filters, ordering, embedding |
| `POST` | `/rest/v1/{table}` | Insert (single row or array) |
| `PATCH` | `/rest/v1/{table}` | Update (requires at least one filter) |
| `DELETE` | `/rest/v1/{table}` | Delete (requires at least one filter) |
| `POST` | `/rest/v1/rpc/{function}` | Call an RPC function |
| `GET` | `/rest/v1/rpc/{function}` | Call an RPC function via GET |

RPC operations inside a batch read parameters only from `body` — the `query` field is ignored for `/rest/v1/rpc/` paths regardless of method. A GET RPC operation with query-string parameters calls the function with no arguments.

## Operation fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | Identifier for referencing in templates. Auto-generated as `op0`, `op1`, etc. if omitted. |
| `method` | string | Yes | HTTP method: `GET`, `POST`, `PATCH`, `DELETE` |
| `path` | string | Yes | Must start with `/rest/v1/` |
| `query` | string | No | URL query string (filters, select, order) |
| `body` | object/array | No | JSON body for POST/PATCH operations |

## Limits

- **Max operations per batch**: 20 (configurable via `MAX_BATCH_OPERATIONS` env var)
- **RLS context**: Resolved once for the entire batch from the request's auth token
- All operations share a single database transaction

## Use cases

- **Order + line items**: Create a parent record and child records atomically
- **Transfer funds**: Debit one account and credit another in a single transaction
- **Cascade updates**: Update multiple related tables with referential integrity
- **Read-after-write**: Insert a row and immediately read it back with joins
