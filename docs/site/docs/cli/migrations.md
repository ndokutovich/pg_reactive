---
title: Migrations
sidebar_position: 4
description: Create and manage database migrations with pgstack migration.
---

# Migrations

pgStack uses a sequential SQL migration system. Migration files are plain `.sql` files numbered sequentially and run in order.

## Commands

### Create a migration

```bash
pgstack migration new <name>
```

Creates a new numbered migration file in the `migrations/` directory:

```bash
pgstack migration new add_products_table
# Creates: migrations/00002_add_products_table.sql
```

The generated file contains a template:

```sql
-- Migration: 00002_add_products_table
-- Created: 2025-01-14T12:00:00Z

-- Write your migration SQL here.
-- To roll back, the system will look for a corresponding rollback migration.
```

### Run migrations

```bash
pgstack migration up
```

Applies all pending migrations in numeric order:

```
Running migration 00001_init.sql... OK
Running migration 00002_add_products_table.sql... OK
All migrations applied. Database is up to date.
```

Migrations are tracked in a `pgstack_migrations` table created automatically.

### List migrations

```bash
pgstack migration list
```

Shows all migrations and their status:

```
#      Name                           Applied At
00001  init                           2025-01-14 12:00:00
00002  add_products_table             2025-01-14 12:05:00
00003  add_orders_table               not applied
```

### Roll back

```bash
pgstack migration rollback
```

Rolls back the most recently applied migration. Looks for the migration SQL and executes a corresponding `_rollback.sql` file if it exists.

```bash
# Rollback migrations must be named:
migrations/00002_add_products_table_rollback.sql
```

If no rollback file exists, the command fails with an error asking you to write one.

## Migration file conventions

Name migrations descriptively:

```
00001_init.sql                    # initial schema
00002_add_products_table.sql      # new table
00003_add_category_to_products.sql # alter table
00004_add_product_search_index.sql # index
00005_seed_categories.sql         # data migration
```

## Example migrations

### Create a table

```sql
-- 00002_add_products_table.sql

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
```

### Add a column

```sql
-- 00003_add_sku_to_products.sql

ALTER TABLE products ADD COLUMN sku TEXT UNIQUE;
CREATE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL;
```

### Add a foreign key

```sql
-- 00004_add_orders_table.sql

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
```

### Data migration

```sql
-- 00005_seed_categories.sql

INSERT INTO categories (name, slug) VALUES
  ('Electronics', 'electronics'),
  ('Clothing', 'clothing'),
  ('Books', 'books'),
  ('Home & Garden', 'home-garden'),
  ('Sports', 'sports')
ON CONFLICT (slug) DO NOTHING;
```

## Rollback files

```sql
-- 00002_add_products_table_rollback.sql

DROP TABLE IF EXISTS products;
```

## Migration table

pgStack tracks applied migrations in:

```sql
SELECT * FROM pgstack_migrations ORDER BY applied_at;
```

| id | name | applied_at |
|----|------|------------|
| 1 | 00001_init | 2025-01-14 12:00:00+00 |
| 2 | 00002_add_products | 2025-01-14 12:05:00+00 |

## Best practices

**One change per migration.** Keep each migration focused. It's easier to roll back a single table drop than to undo a multi-table migration.

**Always test rollbacks.** Write rollback files and test them in development. A migration without a rollback is a liability.

**Never edit applied migrations.** Once a migration has been applied to any environment, don't modify it. Create a new migration instead.

**Use transactions.** Wrap DDL in explicit transactions when running multiple statements, so a failure rolls back everything:

```sql
BEGIN;

ALTER TABLE orders ADD COLUMN notes TEXT;
CREATE INDEX idx_orders_notes_gin ON orders USING gin(to_tsvector('english', notes))
  WHERE notes IS NOT NULL;

COMMIT;
```
