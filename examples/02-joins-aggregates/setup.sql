-- Example 02 — Joins + Aggregates
--
-- Real dashboards aren't `SELECT *` — they're JOIN + GROUP BY + HAVING +
-- window functions. pg_reactive computes deltas via EXCEPT, so the only
-- thing the subscriber sees is "row X changed" — no recomputation in the
-- client.
--
-- Demonstrated SQL:
--   * LEFT JOIN to keep customers with zero orders.
--   * COALESCE / SUM aggregate per customer.
--   * RANK() OVER (PARTITION BY) window.
--   * HAVING filters aggregate rows.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS customers (
  id     serial PRIMARY KEY,
  name   text NOT NULL,
  region text NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id          serial PRIMARY KEY,
  customer_id int  NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product     text NOT NULL,
  qty         int  NOT NULL CHECK (qty > 0),
  total       numeric(10,2) NOT NULL CHECK (total >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON customers, orders TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE customers_id_seq, orders_id_seq TO anon, authenticated;

-- Idempotent reseed.
TRUNCATE customers RESTART IDENTITY CASCADE;

INSERT INTO customers (name, region) VALUES
  ('Alice',  'US-East'),
  ('Bob',    'US-West'),
  ('Carol',  'EU'),
  ('Dave',   'APAC');

INSERT INTO orders (customer_id, product, qty, total) VALUES
  (1, 'Keyboard', 1,  79.99),
  (2, 'Monitor',  1, 349.99),
  (3, 'Mouse',    2,  59.98),
  (1, 'Lamp',     1,  24.99),
  (4, 'Hub',      3, 137.97);

-- Revenue per customer (LEFT JOIN — includes Dave even if he had no orders).
SELECT pgr.subscribe(
  'revenue_by_customer',
  'SELECT c.id, c.name, c.region,
          COALESCE(SUM(o.total), 0)::numeric(10,2) AS revenue,
          COUNT(o.id) AS order_count
   FROM customers c
   LEFT JOIN orders o ON o.customer_id = c.id
   GROUP BY c.id, c.name, c.region
   ORDER BY revenue DESC');

-- Ranks within each region (HAVING + window).
SELECT pgr.subscribe(
  'regional_top_spenders',
  'WITH per_customer AS (
     SELECT c.region, c.name, COALESCE(SUM(o.total), 0)::numeric(10,2) AS revenue
     FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
     GROUP BY c.region, c.name
   )
   SELECT region, name, revenue,
          RANK() OVER (PARTITION BY region ORDER BY revenue DESC) AS rank
   FROM per_customer
   WHERE revenue > 0');
