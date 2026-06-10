-- Example 3: Revenue Dashboard (GROUP BY + SUM)
-- Run AFTER examples 1 and 2 setup.sql
-- docker compose exec -T db psql -U postgres -d pg_reactive_test -f /examples/03-revenue-dashboard/setup.sql

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Add more orders for a richer dashboard.
-- Idempotent: only enrich when orders are sparse, so re-running this file
-- standalone does not append these 7 rows again. In the 01->02->03 sequence
-- example 02 has just reset orders to its seed, so this always tops up.
INSERT INTO orders (customer_id, product_id, qty, total)
SELECT * FROM (VALUES
  (1, 3, 1, 349.99),
  (2, 1, 2, 159.98),
  (3, 6, 1, 45.99),
  (4, 7, 1, 69.99),
  (1, 2, 3, 89.97),
  (2, 6, 2, 91.98),
  (3, 3, 1, 349.99)
) AS v(customer_id, product_id, qty, total)
WHERE (SELECT count(*) FROM orders) < 12;

-- Subscribe: revenue per customer with LEFT JOIN (includes $0 customers)
SELECT pgr.unsubscribe('revenue_by_customer');
SELECT pgr.subscribe('revenue_by_customer',
  'SELECT c.id, c.name, c.region,
          COALESCE(SUM(o.total), 0) AS revenue,
          COUNT(o.id) AS order_count
   FROM customers c
   LEFT JOIN orders o ON o.customer_id = c.id
   GROUP BY c.id, c.name, c.region
   ORDER BY revenue DESC'
);
