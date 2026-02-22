-- Example 2: Order Feed (Multi-table JOIN)
-- Run: docker compose exec -T db psql -U postgres -d pg_reactive_test -f /ext/examples/02-order-feed/setup.sql
-- Requires: Example 1 setup.sql already run (for products table)

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  customer_id int REFERENCES customers(id),
  product_id int REFERENCES products(id),
  qty int NOT NULL,
  total numeric(10,2) NOT NULL,
  created_at timestamp DEFAULT now()
);

-- Clean slate (orders first due to FK)
TRUNCATE orders CASCADE;
DELETE FROM customers;

INSERT INTO customers (name, region) VALUES
  ('Alice Johnson', 'us-east'),
  ('Bob Smith', 'eu-west'),
  ('Carol Williams', 'ap-south'),
  ('Dave Brown', 'us-west');

-- Seed some orders
INSERT INTO orders (customer_id, product_id, qty, total) VALUES
  (1, 1, 1, 79.99),
  (2, 3, 1, 349.99),
  (3, 2, 2, 59.98),
  (1, 4, 1, 45.99),
  (4, 5, 3, 209.97);

-- Subscribe to JOIN query
SELECT pgr.subscribe('order_feed',
  'SELECT o.id, c.name AS customer, c.region, p.name AS product, o.qty, o.total, o.created_at
   FROM orders o
   JOIN customers c ON o.customer_id = c.id
   JOIN products p ON o.product_id = p.id
   ORDER BY o.created_at DESC'
);
