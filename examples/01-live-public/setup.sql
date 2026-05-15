-- Example 01 — Live Public Data
--
-- The simplest case: a query that anyone can watch. Useful for public
-- dashboards (status pages, leaderboards, world events, ticker tape).
--
-- Best-practice notes:
--   * No `audience` argument => the subscription is public. Anyone with a
--     valid WS connection (anon key or JWT) can read it.
--   * Explicit per-table grants since the 2026-05 audit dropped blanket
--     anon/authenticated access to public schema.
--   * Idempotent: TRUNCATE ... RESTART IDENTITY before the re-seed.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS products (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  price     numeric(10,2) NOT NULL,
  category  text NOT NULL,
  in_stock  boolean NOT NULL DEFAULT true
);

GRANT SELECT, INSERT, UPDATE, DELETE ON products TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE products_id_seq TO anon, authenticated;

TRUNCATE products RESTART IDENTITY CASCADE;
INSERT INTO products (name, price, category, in_stock) VALUES
  ('Mechanical Keyboard', 79.99, 'electronics', true),
  ('Wireless Mouse',      29.99, 'electronics', true),
  ('4K Monitor',         349.99, 'electronics', true),
  ('Desk Lamp',           24.99, 'home',        true),
  ('Notebook Set',        12.99, 'office',      true),
  ('USB-C Hub',           45.99, 'electronics', false),
  ('Webcam HD',           69.99, 'electronics', true);

-- Subscribe to in-stock electronics, ordered by price.
SELECT pgr.subscribe(
  'electronics_in_stock',
  'SELECT id, name, price FROM products
   WHERE category = ''electronics'' AND in_stock = true
   ORDER BY price');
