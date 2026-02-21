-- Test: SQL coverage — 11 query types all subscribe and recompute correctly
CREATE EXTENSION pg_reactive;

-- Setup base tables
CREATE TABLE products (id serial PRIMARY KEY, name text, price numeric, category text);
CREATE TABLE orders (id serial PRIMARY KEY, product_id int REFERENCES products(id), qty int, created_at timestamp DEFAULT now());

INSERT INTO products (name, price, category) VALUES
  ('Apple', 1.50, 'fruit'),
  ('Banana', 0.75, 'fruit'),
  ('Carrot', 2.00, 'vegetable'),
  ('Donut', 3.50, 'pastry');

INSERT INTO orders (product_id, qty) VALUES
  (1, 10), (2, 5), (1, 3), (3, 7), (4, 2);

-- 1. Simple SELECT
SELECT pgr.subscribe('cov_simple', 'SELECT id, name, price FROM products');
SELECT count(*) AS simple_snap FROM pgr."_snap_cov_simple";

-- 2. WHERE clause
SELECT pgr.subscribe('cov_where', 'SELECT id, name FROM products WHERE category = ''fruit''');
SELECT count(*) AS where_snap FROM pgr."_snap_cov_where";

-- 3. INNER JOIN
SELECT pgr.subscribe('cov_join', 'SELECT o.id, p.name, o.qty FROM orders o JOIN products p ON o.product_id = p.id');
SELECT count(*) AS join_snap FROM pgr."_snap_cov_join";

-- 4. LEFT JOIN
SELECT pgr.subscribe('cov_leftjoin', 'SELECT p.name, o.qty FROM products p LEFT JOIN orders o ON o.product_id = p.id');
SELECT count(*) AS leftjoin_snap FROM pgr."_snap_cov_leftjoin";

-- 5. GROUP BY
SELECT pgr.subscribe('cov_group', 'SELECT p.category, count(*) AS cnt FROM products p GROUP BY p.category');
SELECT count(*) AS group_snap FROM pgr."_snap_cov_group";

-- 6. HAVING
SELECT pgr.subscribe('cov_having', 'SELECT p.category, count(*) AS cnt FROM products p GROUP BY p.category HAVING count(*) > 1');
SELECT count(*) AS having_snap FROM pgr."_snap_cov_having";

-- 7. DISTINCT
SELECT pgr.subscribe('cov_distinct', 'SELECT DISTINCT category FROM products');
SELECT count(*) AS distinct_snap FROM pgr."_snap_cov_distinct";

-- 8. LIMIT
SELECT pgr.subscribe('cov_limit', 'SELECT id, name FROM products ORDER BY id LIMIT 2');
SELECT count(*) AS limit_snap FROM pgr."_snap_cov_limit";

-- 9. Subquery
SELECT pgr.subscribe('cov_subq', 'SELECT id, name FROM products WHERE id IN (SELECT product_id FROM orders WHERE qty > 5)');
SELECT count(*) AS subq_snap FROM pgr."_snap_cov_subq";

-- 10. CTE
SELECT pgr.subscribe('cov_cte', 'WITH top_orders AS (SELECT product_id, sum(qty) AS total FROM orders GROUP BY product_id) SELECT p.name, t.total FROM products p JOIN top_orders t ON p.id = t.product_id');
SELECT count(*) AS cte_snap FROM pgr."_snap_cov_cte";

-- 11. Window function
SELECT pgr.subscribe('cov_window', 'SELECT id, name, price, rank() OVER (ORDER BY price DESC) AS price_rank FROM products');
SELECT count(*) AS window_snap FROM pgr."_snap_cov_window";

----------------------------------------------------------------------
-- Now test that DML triggers correct recompute for all query types
----------------------------------------------------------------------

-- Insert a new product — should affect most queries
INSERT INTO products (name, price, category) VALUES ('Eclair', 4.00, 'pastry');

-- Verify snapshots updated correctly by checking each matches its query
-- Simple SELECT
SELECT count(*) AS simple_diff FROM (
  (SELECT id, name, price FROM products) EXCEPT (SELECT * FROM pgr."_snap_cov_simple")
) t;

-- WHERE
SELECT count(*) AS where_diff FROM (
  (SELECT id, name FROM products WHERE category = 'fruit') EXCEPT (SELECT * FROM pgr."_snap_cov_where")
) t;

-- GROUP BY (should now have pastry=2)
SELECT count(*) AS group_diff FROM (
  (SELECT p.category, count(*) AS cnt FROM products p GROUP BY p.category)
  EXCEPT (SELECT * FROM pgr."_snap_cov_group")
) t;

-- HAVING (pastry now has count=2, should appear)
SELECT count(*) AS having_diff FROM (
  (SELECT p.category, count(*) AS cnt FROM products p GROUP BY p.category HAVING count(*) > 1)
  EXCEPT (SELECT * FROM pgr."_snap_cov_having")
) t;

-- DISTINCT (pastry already existed, so no change in distinct categories)
SELECT count(*) AS distinct_diff FROM (
  (SELECT DISTINCT category FROM products) EXCEPT (SELECT * FROM pgr."_snap_cov_distinct")
) t;

-- Window function (ranks shift with new product)
SELECT count(*) AS window_diff FROM (
  (SELECT id, name, price, rank() OVER (ORDER BY price DESC) AS price_rank FROM products)
  EXCEPT (SELECT * FROM pgr."_snap_cov_window")
) t;

-- Add an order for the new product — tests JOIN/LEFT JOIN/subquery/CTE updates
INSERT INTO orders (product_id, qty) VALUES (5, 20);

-- JOIN
SELECT count(*) AS join_diff FROM (
  (SELECT o.id, p.name, o.qty FROM orders o JOIN products p ON o.product_id = p.id)
  EXCEPT (SELECT * FROM pgr."_snap_cov_join")
) t;

-- LEFT JOIN
SELECT count(*) AS leftjoin_diff FROM (
  (SELECT p.name, o.qty FROM products p LEFT JOIN orders o ON o.product_id = p.id)
  EXCEPT (SELECT * FROM pgr."_snap_cov_leftjoin")
) t;

-- Subquery (Eclair has qty=20 > 5, should appear)
SELECT count(*) AS subq_diff FROM (
  (SELECT id, name FROM products WHERE id IN (SELECT product_id FROM orders WHERE qty > 5))
  EXCEPT (SELECT * FROM pgr."_snap_cov_subq")
) t;

-- CTE
SELECT count(*) AS cte_diff FROM (
  (WITH top_orders AS (SELECT product_id, sum(qty) AS total FROM orders GROUP BY product_id)
   SELECT p.name, t.total FROM products p JOIN top_orders t ON p.id = t.product_id)
  EXCEPT (SELECT * FROM pgr."_snap_cov_cte")
) t;

-- DELETE a product — verify cascading updates
DELETE FROM orders WHERE product_id = 2;
DELETE FROM products WHERE id = 2;

-- WHERE (fruit now only has Apple)
SELECT count(*) AS where_after_del FROM pgr."_snap_cov_where";

-- GROUP BY (fruit count drops to 1)
SELECT category, cnt FROM pgr."_snap_cov_group" WHERE category = 'fruit';

-- Cleanup
SELECT pgr.unsubscribe('cov_simple');
SELECT pgr.unsubscribe('cov_where');
SELECT pgr.unsubscribe('cov_join');
SELECT pgr.unsubscribe('cov_leftjoin');
SELECT pgr.unsubscribe('cov_group');
SELECT pgr.unsubscribe('cov_having');
SELECT pgr.unsubscribe('cov_distinct');
SELECT pgr.unsubscribe('cov_limit');
SELECT pgr.unsubscribe('cov_subq');
SELECT pgr.unsubscribe('cov_cte');
SELECT pgr.unsubscribe('cov_window');

DROP TABLE orders;
DROP TABLE products;
DROP EXTENSION pg_reactive;
