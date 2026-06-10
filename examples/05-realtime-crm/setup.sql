-- Example 5: Real-Time CRM Dashboard
-- Run AFTER examples 1 and 2 setup.sql
-- docker compose exec -T db psql -U postgres -d pg_reactive_test -f /examples/05-realtime-crm/setup.sql
--
-- Production hardening note: the three subscriptions below are public —
-- anyone with a WS session sees the same rows. For a real CRM that is
-- always wrong; each rep must see only their own customers. The pattern:
--
--   CREATE FUNCTION public.subscribe_my_crm() RETURNS text
--     LANGUAGE plpgsql SECURITY DEFINER
--     SET search_path = pg_catalog, pg_temp AS $$
--   DECLARE qid text := 'top_customers_' || auth.uid()::text;
--   BEGIN
--     PERFORM pgr.subscribe(qid,
--       format('SELECT ... FROM public.customers WHERE owner_id = %L', auth.uid()),
--       'delta',
--       jsonb_build_object('sub', auth.uid()::text)  -- audience binding
--     );
--     RETURN qid;
--   END $$;
--   REVOKE EXECUTE ON FUNCTION public.subscribe_my_crm() FROM PUBLIC;
--   GRANT  EXECUTE ON FUNCTION public.subscribe_my_crm() TO authenticated;
--
-- audience binding is enforced by the WS gate: even if a user guesses
-- another rep's query_id, the proxy refuses to deliver deltas whose
-- audience.sub does not match their JWT. See SECURITY.md trust matrix
-- "WebSocket: open /ws/{queryId}" and docs/specs/pg_reactive_spec.md §9.4.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Ensure enough seed data
INSERT INTO orders (customer_id, product_id, qty, total)
SELECT
  (random() * 3 + 1)::int,
  (random() * 6 + 1)::int,
  (random() * 5 + 1)::int,
  round((random() * 500 + 10)::numeric, 2)
FROM generate_series(1, 20)
-- Idempotent: only top up when orders are sparse, so re-running this
-- file does not pile on 20 more random orders every time.
WHERE (SELECT count(*) FROM orders) < 15;

-- Query 1: Top customers by total spend (CTE + JOIN)
SELECT pgr.unsubscribe('top_customers');
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
SELECT pgr.unsubscribe('recent_orders');
SELECT pgr.subscribe('recent_orders',
  'SELECT o.id, c.name AS customer, p.name AS product, o.total, o.created_at
   FROM orders o
   JOIN customers c ON o.customer_id = c.id
   JOIN products p ON o.product_id = p.id
   ORDER BY o.created_at DESC
   LIMIT 10'
);

-- Query 3: Revenue by region (GROUP BY + LEFT JOIN)
SELECT pgr.unsubscribe('revenue_by_region');
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
