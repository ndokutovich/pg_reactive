---
title: Filters
sidebar_position: 2
description: All REST API filter operators — eq, neq, gt, lt, like, ilike, in, is, cs, cd, fts, ov, and logical combinators or/and.
---

# Filters

Filters are passed as query parameters. The format is:

```
?column=operator.value
```

Multiple filters are combined with AND:

```
?status=eq.active&price=gt.100
```

## Comparison operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | equals | `?status=eq.active` |
| `neq` | not equal | `?status=neq.deleted` |
| `gt` | greater than | `?price=gt.100` |
| `gte` | greater than or equal | `?price=gte.100` |
| `lt` | less than | `?price=lt.500` |
| `lte` | less than or equal | `?price=lte.500` |
| `like` | SQL LIKE (case-sensitive) | `?name=like.*laptop*` |
| `ilike` | SQL ILIKE (case-insensitive) | `?name=ilike.*laptop*` |
| `is` | IS NULL / IS TRUE / IS FALSE | `?deleted_at=is.null` |
| `in` | value in list | `?status=in.(pending,processing)` |
| `not` | negate operator | `?status=not.eq.deleted` |
| `cs` | contains (arrays) | `?tags=cs.{go}` |
| `cd` | contained by (arrays) | `?tags=cd.{go,rust}` |
| `ov` | overlap (arrays) | `?tags=ov.{go,rust}` |
| `fts` | full-text search | `?content=fts.hello` |
| `sl` | strictly left of (ranges) | `?range=sl.[1,5]` |
| `sr` | strictly right of (ranges) | `?range=sr.[1,5]` |
| `adj` | adjacent (ranges) | `?range=adj.[1,5]` |

## Examples

### Equality

```bash
GET /rest/v1/products?active=eq.true
GET /rest/v1/orders?status=eq.shipped
GET /rest/v1/users?id=eq.550e8400-e29b-41d4-a716-446655440000
```

### Comparison

```bash
# Products over $100
GET /rest/v1/products?price=gt.100

# Products between $10 and $200
GET /rest/v1/products?price=gte.10&price=lte.200

# Orders placed in the last 24 hours
GET /rest/v1/orders?created_at=gte.2025-01-14T00:00:00Z
```

### Text search

```bash
# Case-insensitive search (like a SQL ILIKE)
GET /rest/v1/products?name=ilike.*laptop*

# Exact prefix match (case-sensitive)
GET /rest/v1/products?sku=like.LAPTOP*

# Products whose description contains "wireless"
GET /rest/v1/products?description=ilike.*wireless*
```

### NULL checks

```bash
# Rows where deleted_at is NULL (not soft-deleted)
GET /rest/v1/users?deleted_at=is.null

# Rows where deleted_at is NOT NULL (soft-deleted)
GET /rest/v1/users?deleted_at=not.is.null
```

### IN operator

```bash
# Orders with any of these statuses
GET /rest/v1/orders?status=in.(pending,processing,shipped)

# Products in specific categories
GET /rest/v1/products?category_id=in.(1,2,3)
```

### Negation

```bash
# All users except admins
GET /rest/v1/users?role=not.eq.admin

# Orders not in cancelled state
GET /rest/v1/orders?status=not.eq.cancelled

# Rows where NOT NULL
GET /rest/v1/tasks?completed_at=not.is.null
```

### Array operators

```bash
# Products tagged with "go" (contains)
GET /rest/v1/products?tags=cs.{go}

# Products whose tags are all within {go,rust,python} (contained by)
GET /rest/v1/products?tags=cd.{go,rust,python}

# Products tagged with "go" or "rust" (overlap)
GET /rest/v1/products?tags=ov.{go,rust}
```

**SQL equivalents:**

| Filter | SQL |
|--------|-----|
| `?tags=cs.{go}` | `tags @> '{go}'` |
| `?tags=cd.{go,rust}` | `tags <@ '{go,rust}'` |
| `?tags=ov.{go,rust}` | `tags && '{go,rust}'` |

### Full-text search

```bash
# Rows where content matches the search term
GET /rest/v1/articles?content=fts.hello

# Combine with other filters
GET /rest/v1/articles?content=fts.database&status=eq.published
```

**SQL equivalent:** `content @@ 'hello'`

### Range operators

```bash
# Ranges strictly left of [1,5]
GET /rest/v1/events?range=sl.[1,5]

# Ranges strictly right of [1,5]
GET /rest/v1/events?range=sr.[1,5]

# Ranges adjacent to [1,5]
GET /rest/v1/events?range=adj.[1,5]
```

**SQL equivalents:**

| Filter | SQL |
|--------|-----|
| `?range=sl.[1,5]` | `range << '[1,5]'` |
| `?range=sr.[1,5]` | `range >> '[1,5]'` |
| `?range=adj.[1,5]` | `range -\|- '[1,5]'` |

## SDK filter methods

The TypeScript SDK has dedicated methods for each operator:

```typescript
// eq / neq
await pgstack.from('orders').select('*').eq('status', 'active');
await pgstack.from('orders').select('*').neq('status', 'deleted');

// Comparison
await pgstack.from('products').select('*').gt('price', 100);
await pgstack.from('products').select('*').gte('price', 100);
await pgstack.from('products').select('*').lt('price', 500);
await pgstack.from('products').select('*').lte('price', 500);

// Text search
await pgstack.from('products').select('*').like('name', '%Laptop%');
await pgstack.from('products').select('*').ilike('name', '%laptop%');

// NULL check
await pgstack.from('users').select('*').is('deleted_at', null);
await pgstack.from('users').select('*').is('active', true);

// IN operator
await pgstack.from('orders').select('*').in('status', ['pending', 'processing']);

// NOT
await pgstack.from('users').select('*').not('role', 'eq', 'admin');

// Raw filter (any operator)
await pgstack.from('orders').select('*').filter('amount', 'gt', 100);
```

## Ordering

```bash
# Ascending (default)
GET /rest/v1/products?order=price.asc

# Descending
GET /rest/v1/products?order=price.desc

# Multiple columns
GET /rest/v1/orders?order=status.asc,created_at.desc

# NULLs first/last
GET /rest/v1/tasks?order=completed_at.desc.nullslast
```

SDK:

```typescript
await pgstack.from('products')
  .select('*')
  .order('price', { ascending: false });

await pgstack.from('orders')
  .select('*')
  .order('status')
  .order('created_at', { ascending: false });

await pgstack.from('tasks')
  .select('*')
  .order('completed_at', { ascending: false, nullsFirst: false });
```

## Combining filters

```bash
# Active products under $200 with "laptop" in the name
GET /rest/v1/products?active=eq.true&price=lt.200&name=ilike.*laptop*

# Pending or processing orders for a specific customer
GET /rest/v1/orders?customer_id=eq.42&status=in.(pending,processing)
```

SDK:

```typescript
const { data } = await pgstack.from('products')
  .select('id,name,price')
  .eq('active', true)
  .lt('price', 200)
  .ilike('name', '%laptop%')
  .order('price', { ascending: true });
```

## Logical combinators

Combine multiple conditions with `or()` or `and()`:

```bash
GET /rest/v1/products?or=(status.eq.active,status.eq.pending)
GET /rest/v1/products?and=(price.gt.10,price.lt.100)
```

`or()` and `and()` can be combined with regular filters -- regular filters are always ANDed:

```bash
GET /rest/v1/products?category=eq.electronics&or=(status.eq.active,status.eq.pending)
```

This returns electronics products where status is active OR pending.

SDK:

```typescript
// OR combinator
const { data } = await pgstack.from('products')
  .select('*')
  .or('status.eq.active,status.eq.pending');

// AND combinator (explicit)
const { data } = await pgstack.from('products')
  .select('*')
  .and('price.gt.10,price.lt.100');

// Combined with regular filters
const { data } = await pgstack.from('products')
  .select('*')
  .eq('category', 'electronics')
  .or('status.eq.active,status.eq.pending');
```

## Wildcard patterns

The `like` and `ilike` operators use `*` as the wildcard (translated to SQL `%`):

| Pattern | Matches |
|---------|---------|
| `*laptop*` | anything containing "laptop" |
| `laptop*` | anything starting with "laptop" |
| `*laptop` | anything ending with "laptop" |
| `lap*op` | "laptop", "lapdrop", etc. |

## Case sensitivity

- `like` — case-sensitive (uses SQL `LIKE`)
- `ilike` — case-insensitive (uses SQL `ILIKE`)

For most text searches, `ilike` is what you want.
