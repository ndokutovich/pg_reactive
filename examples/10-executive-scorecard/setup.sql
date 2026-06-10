-- Example 10: Executive Scorecard
-- Demonstrates: Complex single-row aggregates, DISTINCT counts, computed ratios
--
-- Production hardening note: this subscription is public for clarity. A
-- real executive dashboard is always scoped to ONE organisation. The
-- production-correct shape adds an `org_id` claim to the viewer's JWT
-- (set during signup / SSO) and an RLS policy on `orders` / `customers`
-- that filters to the caller's org:
--
--   ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY orders_org_scope ON public.orders
--     USING (org_id = (auth.jwt() ->> 'org_id')::uuid);
--
-- With RLS in place the public subscription below would naturally return
-- only the caller's org's KPIs — no SQL change needed because the
-- subscription's recompute runs under the caller's role, so the policy
-- applies. See SECURITY.md "Capability × role matrix" and
-- docs/specs/pg_reactive_spec.md for the audience-bound variant.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

SELECT pgr.unsubscribe('exec_kpis');
SELECT pgr.subscribe('exec_kpis',
  'SELECT COUNT(DISTINCT o.customer_id) AS active_customers,
          COUNT(o.id) AS total_orders,
          ROUND(COALESCE(SUM(o.total), 0)::numeric, 2) AS total_revenue,
          ROUND(COALESCE(AVG(o.total), 0)::numeric, 2) AS avg_order_value,
          ROUND(COALESCE(SUM(o.total), 0)::numeric / NULLIF(COUNT(DISTINCT o.customer_id), 0), 2) AS revenue_per_customer,
          COUNT(DISTINCT o.product_id) AS products_sold
   FROM orders o');
