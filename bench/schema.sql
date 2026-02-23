-- bench/schema.sql — Shared benchmark schema
-- Used by all approaches for fair comparison.

DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

CREATE TABLE customers (
    id serial PRIMARY KEY,
    name text NOT NULL,
    region text NOT NULL,
    tier text NOT NULL DEFAULT 'standard'
);

CREATE TABLE products (
    id serial PRIMARY KEY,
    name text NOT NULL,
    price numeric(10,2) NOT NULL,
    category text NOT NULL
);

CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id int NOT NULL REFERENCES customers(id),
    product_id int NOT NULL REFERENCES products(id),
    qty int NOT NULL,
    total numeric(10,2) NOT NULL,
    created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_product ON orders(product_id);
CREATE INDEX idx_orders_created ON orders(created_at);

-- Publication for logical replication (Debezium, Supabase, Electric)
DROP PUBLICATION IF EXISTS bench_pub;
CREATE PUBLICATION bench_pub FOR TABLE customers, products, orders;
