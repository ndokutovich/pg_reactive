-- Example 12: Interactive Tutorial Console
-- Minimal setup: creates tables + seed data only.
-- The tutorial walks through subscribing, DML, and all features step by step.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Products table
CREATE TABLE IF NOT EXISTS tut_products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL
);

-- Customers table
CREATE TABLE IF NOT EXISTS tut_customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL
);

-- Orders table (references products + customers)
CREATE TABLE IF NOT EXISTS tut_orders (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES tut_customers(id),
  product_id INT REFERENCES tut_products(id),
  quantity INT NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed data
INSERT INTO tut_products (name, category, price) VALUES
  ('Laptop',    'electronics', 999.99),
  ('Keyboard',  'electronics', 79.99),
  ('Mouse',     'electronics', 29.99),
  ('Desk',      'furniture',   349.99),
  ('Chair',     'furniture',   249.99);

INSERT INTO tut_customers (name, region) VALUES
  ('Alice', 'US-West'),
  ('Bob',   'US-East'),
  ('Carol', 'EU');

INSERT INTO tut_orders (customer_id, product_id, quantity, total) VALUES
  (1, 1, 1, 999.99),
  (1, 2, 2, 159.98),
  (2, 3, 3,  89.97),
  (3, 4, 1, 349.99);
