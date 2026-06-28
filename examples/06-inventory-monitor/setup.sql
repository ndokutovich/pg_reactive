-- Example 6: Inventory Monitor
-- Demonstrates: CASE expressions, JOIN with conditional status, stock alerts

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Re-seed-safe: DROP first so a table left over from an OLDER demo schema is
-- replaced with the current one. `CREATE TABLE IF NOT EXISTS` silently keeps a
-- stale table when the schema EVOLVED, so a subscribe query could select a
-- column that no longer exists → "column ... does not exist" (SQLSTATE 42703).
-- Demo data is disposable and the setup service re-seeds on boot, so a
-- drop+recreate is the right idempotency. (Mirrors examples/apps/todo.)
DROP TABLE IF EXISTS public.inventory CASCADE;
CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 10,
  warehouse TEXT NOT NULL DEFAULT 'main',
  UNIQUE(product_id)
);

-- Production-ready: a public-READ inventory dashboard; writes (stock changes)
-- come from server-side psql, locked to service_role for network clients.
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_public_read ON inventory;
CREATE POLICY inventory_public_read ON inventory FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON inventory TO anon, authenticated;

-- Seed inventory for all products (skip if already populated)
INSERT INTO inventory (product_id, stock_qty, reorder_point, warehouse)
SELECT p.id,
  CASE
    WHEN p.id % 5 = 0 THEN 0
    WHEN p.id % 3 = 0 THEN floor(random() * 8 + 1)::int
    ELSE floor(random() * 80 + 20)::int
  END,
  10,
  (ARRAY['warehouse-a', 'warehouse-b', 'warehouse-c'])[floor(random() * 3 + 1)::int]
FROM products p
WHERE NOT EXISTS (SELECT 1 FROM inventory WHERE product_id = p.id);

SELECT pgr.unsubscribe('inventory_status');
SELECT pgr.subscribe('inventory_status',
  'SELECT p.id, p.name, p.price, p.category,
          i.stock_qty, i.reorder_point, i.warehouse,
          CASE WHEN i.stock_qty <= 0 THEN ''out_of_stock''
               WHEN i.stock_qty <= i.reorder_point THEN ''low_stock''
               ELSE ''in_stock'' END AS status
   FROM products p
   JOIN inventory i ON p.id = i.product_id
   ORDER BY i.stock_qty ASC');
