-- Example 1: Live Product Catalog
-- Run: docker compose exec -T db psql -U postgres -d pg_reactive_test -f /examples/01-live-products/setup.sql

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  price numeric(10,2) NOT NULL,
  category text NOT NULL
);

-- Production-ready: a public-READ live catalog with writes locked to service_role.
-- The demo's live updates come from server-side psql (run this file again, or
-- INSERT/UPDATE via psql), never browser-anon writes — so anon never needs DML.
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_public_read ON products;
CREATE POLICY products_public_read ON products FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON products TO anon, authenticated;

-- Clean slate (idempotent: RESTART IDENTITY keeps product ids stable across re-runs;
-- CASCADE wipes dependent FK rows in orders/inventory if those tables already exist)
TRUNCATE products RESTART IDENTITY CASCADE;

INSERT INTO products (name, price, category) VALUES
  ('Mechanical Keyboard', 79.99, 'electronics'),
  ('Wireless Mouse', 29.99, 'electronics'),
  ('4K Monitor', 349.99, 'electronics'),
  ('Desk Lamp', 24.99, 'home'),
  ('Notebook Set', 12.99, 'office'),
  ('USB-C Hub', 45.99, 'electronics'),
  ('Webcam HD', 69.99, 'electronics');

-- Subscribe to filtered live query
SELECT pgr.unsubscribe('electronics');
SELECT pgr.subscribe('electronics',
  'SELECT id, name, price FROM products WHERE category = ''electronics'' ORDER BY price'
);
