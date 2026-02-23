-- Example 10: Executive Scorecard
-- Demonstrates: Complex single-row aggregates, DISTINCT counts, computed ratios

CREATE EXTENSION IF NOT EXISTS pg_reactive;

SELECT pgr.subscribe('exec_kpis',
  'SELECT COUNT(DISTINCT o.customer_id) AS active_customers,
          COUNT(o.id) AS total_orders,
          ROUND(COALESCE(SUM(o.total), 0)::numeric, 2) AS total_revenue,
          ROUND(COALESCE(AVG(o.total), 0)::numeric, 2) AS avg_order_value,
          ROUND(COALESCE(SUM(o.total), 0)::numeric / NULLIF(COUNT(DISTINCT o.customer_id), 0), 2) AS revenue_per_customer,
          COUNT(DISTINCT o.product_id) AS products_sold
   FROM orders o');
