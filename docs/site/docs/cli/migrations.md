---
title: Migrations
sidebar_position: 4
description: Create and manage database migrations with pgstack migration.
---

# Migrations

pgStack uses a plain-SQL migration system. Migration files are `.sql` files prefixed with a `YYYYMMDDHHMMSS` timestamp (e.g. `20250114120000_add_products_table.sql`) and applied in filename sort order; the scaffolded bootstrap migration `00000000000000_pgstack_init.sql` sorts first.

## Commands

### Create a migration

```bash
pgstack migration create <name>
```

Creates a new timestamped migration file in the `migrations/` directory:

```bash
pgstack migration create add_products_table
# Creates: migrations/20250114120000_add_products_table.sql
```

The generated file contains a template:

```sql
-- Migration: add_products_table
-- Created at: 2025-01-14T12:00:00.000Z

-- migrate:up


-- migrate:down
```

SQL under `-- migrate:up` is applied by `pgstack migration run`; SQL under `-- migrate:down` is executed on rollback.

### Run migrations

```bash
pgstack migration run
```

Applies all pending migrations in filename sort order:

```
  + 20250114120000_add_products_table
  + 20250114120500_add_sku_to_products
Applied 2 migration(s).
```

Migrations are tracked in a `pgstack.migrations` table (schema `pgstack`, table `migrations`) created automatically.

### Migration status

```bash
pgstack migration status
```

Shows all migrations and their status:

```
Migration Status:

  v 00000000000000_pgstack_init  applied 1/14/2025, 12:00:00 PM
  v 20250114120000_add_products_table  applied 1/14/2025, 12:05:00 PM
  o 20250114121000_add_orders_table  pending
```

### Roll back

```bash
pgstack migration rollback
```

Options:

- `-n, --count <n>` — number of migrations to roll back (default: 1)
- `--dry-run` — print the down SQL that would be executed without running it

Rolls back the most recently applied migration(s) by executing the SQL in the `-- migrate:down` section of the same migration file, then deleting its row from `pgstack.migrations`. If the migration file is missing or has no `-- migrate:down` section, that migration is skipped with a warning — the command does not fail.

Roll back several migrations at once, or preview the SQL first:

```bash
pgstack migration rollback -n 2          # roll back the last 2 migrations
pgstack migration rollback --dry-run     # print the rollback SQL without executing
```

## Migration file conventions

Name migrations descriptively:

```
00000000000000_pgstack_init.sql              # scaffolded bootstrap (sorts first)
20250114120000_add_products_table.sql        # new table
20250114120500_add_category_to_products.sql  # alter table
20250114121000_add_product_search_index.sql  # index
20250114121500_seed_categories.sql           # data migration
```

## Example migrations

### Create a table

```sql
-- 20250114120000_add_products_table.sql

-- migrate:up
CREATE TABLE products (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_active ON products(active) WHERE active = true;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read active products"
  ON products FOR SELECT
  USING (active = true);

CREATE POLICY "Service role full access"
  ON products FOR ALL
  USING (auth.role() = 'service_role');

GRANT SELECT ON products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON products TO service_role;
GRANT USAGE, SELECT ON SEQUENCE products_id_seq TO service_role;

-- migrate:down
DROP TABLE IF EXISTS products;
```

### Add a column

```sql
-- 20250114120500_add_sku_to_products.sql

-- migrate:up
ALTER TABLE products ADD COLUMN sku TEXT UNIQUE;
CREATE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL;

-- migrate:down
ALTER TABLE products DROP COLUMN IF EXISTS sku;
```

### Add a foreign key

```sql
-- 20250114121000_add_orders_table.sql

-- migrate:up
CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  amount      NUMERIC(10, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own orders" ON orders
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users insert own orders" ON orders
  FOR INSERT WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON orders TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO authenticated;

-- migrate:down
DROP TABLE IF EXISTS orders;
```

### Data migration

```sql
-- 20250114121500_seed_categories.sql

-- migrate:up
INSERT INTO categories (name, slug) VALUES
  ('Electronics', 'electronics'),
  ('Clothing', 'clothing'),
  ('Books', 'books'),
  ('Home & Garden', 'home-garden'),
  ('Sports', 'sports')
ON CONFLICT (slug) DO NOTHING;

-- migrate:down
DELETE FROM categories
WHERE slug IN ('electronics', 'clothing', 'books', 'home-garden', 'sports');
```

## Rollback sections

Rollback SQL lives in the same migration file, under the `-- migrate:down` marker:

```sql
-- 20250114120000_add_products_table.sql

-- migrate:up
CREATE TABLE products (...);

-- migrate:down
DROP TABLE IF EXISTS products;
```

`pgstack migration rollback` executes the `-- migrate:down` section of the most recently applied migration.

## Migration table

pgStack tracks applied migrations in:

```sql
SELECT * FROM pgstack.migrations ORDER BY applied_at;
```

| id | name | applied_at |
|----|------|------------|
| 1 | 00000000000000_pgstack_init | 2025-01-14 12:00:00+00 |
| 2 | 20250114120000_add_products_table | 2025-01-14 12:05:00+00 |

## Best practices

**One change per migration.** Keep each migration focused. It's easier to roll back a single table drop than to undo a multi-table migration.

**Always test rollbacks.** Write rollback files and test them in development. A migration without a rollback is a liability.

**Never edit applied migrations.** Once a migration has been applied to any environment, don't modify it. Create a new migration instead.

**Transactions are automatic.** Each migration runs inside a single transaction (`BEGIN` ... `COMMIT`) — if any statement fails, the whole migration rolls back and is not recorded. Do not add explicit `BEGIN`/`COMMIT` to migration files.
