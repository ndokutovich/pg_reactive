-- Example 5: Real-Time CRM Dashboard
-- Run AFTER examples 1 and 2 setup.sql
-- docker compose exec -T db psql -U postgres -d pg_reactive_test -f /ext/examples/05-realtime-crm/setup.sql

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Ensure enough seed data
INSERT INTO orders (customer_id, product_id, qty, total)
SELECT
  (random() * 3 + 1)::int,
  (random() * 6 + 1)::int,
  (random() * 5 + 1)::int,
  round((random() * 500 + 10)::numeric, 2)
FROM generate_series(1, 20);

-- Query 1: Top customers by total spend (CTE + JOIN)
SELECT pgr.subscribe('top_customers',
  'WITH customer_stats AS (
     SELECT customer_id,
            COUNT(*) AS order_count,
            SUM(total) AS total_spent
     FROM orders
     GROUP BY customer_id
   )
   SELECT c.name, c.region, cs.order_count, cs.total_spent
   FROM customers c
   JOIN customer_stats cs ON c.id = cs.customer_id
   ORDER BY cs.total_spent DESC'
);

-- Query 2: Latest 10 orders (ORDER BY + LIMIT + JOIN)
SELECT pgr.subscribe('recent_orders',
  'SELECT o.id, c.name AS customer, p.name AS product, o.total, o.created_at
   FROM orders o
   JOIN customers c ON o.customer_id = c.id
   JOIN products p ON o.product_id = p.id
   ORDER BY o.created_at DESC
   LIMIT 10'
);

-- Query 3: Revenue by region (GROUP BY + LEFT JOIN)
SELECT pgr.subscribe('revenue_by_region',
  'SELECT c.region,
          COUNT(DISTINCT c.id) AS customers,
          COUNT(o.id) AS orders,
          COALESCE(SUM(o.total), 0) AS revenue
   FROM customers c
   LEFT JOIN orders o ON o.customer_id = c.id
   GROUP BY c.region
   ORDER BY revenue DESC'
);
