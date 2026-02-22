-- pg_reactive examples demo script
-- Run: docker compose exec -T db psql -U postgres -d pg_reactive_test -f /examples/demo.sql
-- Then watch the browser at http://127.0.0.1:3000
--
-- Each statement fires live deltas to all connected UIs.

\echo '=== pg_reactive Live Demo ==='
\echo ''

-- ── 1. Add a new product (Example 1: Live Products + Example 4: Leaderboard) ──
\echo '>>> INSERT product: Gaming Headset $129.99'
INSERT INTO products (name, price, category) VALUES ('Gaming Headset', 129.99, 'electronics');
SELECT pg_sleep(2);

-- ── 2. Update a price (triggers delta: old row deleted, new row inserted) ──
\echo '>>> UPDATE price: Wireless Mouse $29.99 -> $19.99'
UPDATE products SET price = 19.99 WHERE name = 'Wireless Mouse';
SELECT pg_sleep(2);

-- ── 3. New customer ──
\echo '>>> INSERT customer: Eve Chen (eu-west)'
INSERT INTO customers (name, region) VALUES ('Eve Chen', 'eu-west');
SELECT pg_sleep(2);

-- ── 4. New order (affects: Order Feed, Revenue, CRM) ──
\echo '>>> INSERT order: Eve buys 4K Monitor'
INSERT INTO orders (customer_id, product_id, qty, total)
VALUES (
  (SELECT id FROM customers WHERE name = 'Eve Chen'),
  (SELECT id FROM products WHERE name = '4K Monitor'),
  1, 349.99
);
SELECT pg_sleep(2);

-- ── 5. Bulk orders (big wave of deltas) ──
\echo '>>> INSERT 5 random orders (bulk wave)'
INSERT INTO orders (customer_id, product_id, qty, total)
SELECT
  (random() * 4 + 1)::int,
  (random() * 6 + 1)::int,
  (random() * 3 + 1)::int,
  round((random() * 200 + 20)::numeric, 2)
FROM generate_series(1, 5);
SELECT pg_sleep(2);

-- ── 6. Price drop on expensive item ──
\echo '>>> UPDATE price: 4K Monitor $349.99 -> $279.99'
UPDATE products SET price = 279.99 WHERE name = '4K Monitor';
SELECT pg_sleep(2);

-- ── 7. Delete a product (cascading effect) ──
\echo '>>> DELETE product: Gaming Headset'
DELETE FROM products WHERE name = 'Gaming Headset';
SELECT pg_sleep(2);

-- ── 8. Restore original state ──
\echo '>>> Restoring original prices...'
UPDATE products SET price = 29.99 WHERE name = 'Wireless Mouse';
UPDATE products SET price = 349.99 WHERE name = '4K Monitor';

\echo ''
\echo '=== Demo complete! ==='
\echo 'All changes were pushed live to connected browsers.'
