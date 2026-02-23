-- bench/queries.sql — The 8 test queries (Q1-Q8)
-- Each query is stored as a named prepared statement for use by the harness.
-- The harness reads this file and extracts queries by ID.

-- Q1: Orders with customer+product names (JOIN x2)
-- ID: Q1
SELECT o.id, c.name AS customer, p.name AS product, o.qty, o.total
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
WHERE c.region = 'us-east';

-- Q2: Filtered single-table (WHERE)
-- ID: Q2
SELECT id, name, price FROM products WHERE category = 'electronics';

-- Q3: All order details (inner JOIN)
-- ID: Q3
SELECT o.id, c.name AS customer, p.name AS product, o.qty, o.total
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id;

-- Q4: Revenue per customer (LEFT JOIN + GROUP BY + SUM)
-- ID: Q4
SELECT c.id, c.name, c.region, COALESCE(SUM(o.total), 0) AS revenue, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.region;

-- Q5: Categories with avg price > 30 (GROUP BY + HAVING)
-- ID: Q5
SELECT category, AVG(price) AS avg_price, COUNT(*) AS cnt
FROM products
GROUP BY category
HAVING AVG(price) > 30;

-- Q6: Price ranking by category (Window function)
-- ID: Q6
SELECT id, name, price, category,
       RANK() OVER (PARTITION BY category ORDER BY price DESC) AS cat_rank
FROM products;

-- Q7: Top customers by order count (CTE + JOIN)
-- ID: Q7
WITH customer_orders AS (
    SELECT customer_id, COUNT(*) AS cnt, SUM(total) AS total_spent
    FROM orders GROUP BY customer_id
)
SELECT c.name, c.region, co.cnt, co.total_spent
FROM customers c
JOIN customer_orders co ON c.id = co.customer_id;

-- Q8: Recent 50 orders (ORDER BY + LIMIT)
-- ID: Q8
SELECT o.id, c.name AS customer, p.name AS product, o.total, o.created_at
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products p ON o.product_id = p.id
ORDER BY o.created_at DESC
LIMIT 50;
