-- Example 8: Order Analytics
-- Demonstrates: date_trunc time bucketing, GROUP BY on expressions, time-series aggregates

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Backfill some orders across recent hours for a meaningful chart
INSERT INTO orders (customer_id, product_id, qty, total, created_at)
SELECT
  (floor(random() * (SELECT COUNT(*) FROM customers)) + 1)::int,
  (floor(random() * (SELECT COUNT(*) FROM products)) + 1)::int,
  floor(random() * 5 + 1)::int,
  round((random() * 200 + 20)::numeric, 2),
  NOW() - (interval '1 hour' * floor(random() * 12))
FROM generate_series(1, 20)
-- Idempotent: seed the hour-spread batch only once. Re-running this file
-- skips it when backfilled orders (older than ~30 min) already exist.
WHERE NOT EXISTS (
  SELECT 1 FROM orders WHERE created_at < now() - interval '30 minutes'
);

SELECT pgr.unsubscribe('hourly_orders');
SELECT pgr.subscribe('hourly_orders',
  'SELECT date_trunc(''hour'', created_at)::text AS time_bucket,
          COUNT(*) AS order_count,
          ROUND(SUM(total)::numeric, 2) AS revenue,
          ROUND(AVG(total)::numeric, 2) AS avg_value
   FROM orders
   GROUP BY date_trunc(''hour'', created_at)
   ORDER BY time_bucket DESC');
