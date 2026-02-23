-- bench/seed.sql — Parameterized data seeder
-- Usage: psql -v scale=100 -f seed.sql
-- scale=100 → 100 customers, 20 products, 500 orders
-- scale=1000 → 1000 customers, 200 products, 5000 orders

\set n_customers :scale
\set n_products (:scale / 5)
\set n_orders (:scale * 5)

TRUNCATE orders, products, customers RESTART IDENTITY CASCADE;

INSERT INTO customers (name, region, tier)
SELECT
    'customer_' || i,
    (ARRAY['us-east', 'us-west', 'eu-west', 'ap-south'])[1 + (i % 4)],
    (ARRAY['standard', 'premium', 'enterprise'])[1 + (i % 3)]
FROM generate_series(1, :n_customers) i;

INSERT INTO products (name, price, category)
SELECT
    'product_' || i,
    (10 + (i * 7) % 90)::numeric(10,2),
    (ARRAY['electronics', 'clothing', 'food', 'books', 'tools'])[1 + (i % 5)]
FROM generate_series(1, :n_products) i;

INSERT INTO orders (customer_id, product_id, qty, total, created_at)
SELECT
    1 + (i % :n_customers),
    1 + (i % :n_products),
    1 + (i % 20),
    (10 + (i * 13) % 490)::numeric(10,2),
    now() - ((i % 90) || ' days')::interval
FROM generate_series(1, :n_orders) i;

ANALYZE customers, products, orders;
