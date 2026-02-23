-- Test: notify (invalidation) mode
CREATE EXTENSION pg_reactive;

CREATE TABLE orders (id serial PRIMARY KEY, item text, qty int);

-- 1. Subscribe in notify mode
SELECT pgr.subscribe('nm_q1', 'SELECT * FROM orders', 'notify');

-- 2. No snapshot table should exist for notify-mode subscriptions
SELECT count(*) AS snap_exists
FROM pg_tables
WHERE schemaname = 'pgr' AND tablename = '_snap_nm_q1';

-- 3. get_subscriptions shows mode column
SELECT query_id, mode FROM pgr.get_subscriptions() WHERE query_id = 'nm_q1';

-- 4. DML triggers fire — just sends invalidation, no snapshot to check
INSERT INTO orders (item, qty) VALUES ('widget', 10);

-- 5. Still no snapshot table after DML
SELECT count(*) AS snap_exists
FROM pg_tables
WHERE schemaname = 'pgr' AND tablename = '_snap_nm_q1';

-- 6. Verify invalidation_count incremented
SELECT query_id, (invalidation_count > 0) AS was_invalidated
FROM pgr.get_subscriptions() WHERE query_id = 'nm_q1';

-- 7. UPDATE also triggers invalidation
UPDATE orders SET qty = 20 WHERE item = 'widget';

-- 8. DELETE also triggers invalidation
DELETE FROM orders WHERE item = 'widget';

-- 9. Subscribe in delta mode (default) works as before
SELECT pgr.subscribe('nm_q2', 'SELECT * FROM orders');

-- 10. Delta mode DOES have a snapshot table
SELECT count(*) AS snap_exists
FROM pg_tables
WHERE schemaname = 'pgr' AND tablename = '_snap_nm_q2';

-- 11. get_subscriptions shows both modes
SELECT query_id, mode FROM pgr.get_subscriptions() ORDER BY query_id;

-- 12. Invalid mode raises error
SELECT pgr.subscribe('nm_q3', 'SELECT * FROM orders', 'invalid');

-- 13. Explicit delta mode works
SELECT pgr.subscribe('nm_q4', 'SELECT * FROM orders', 'delta');

SELECT query_id, mode FROM pgr.get_subscriptions() WHERE query_id = 'nm_q4';

-- 14. Unsubscribe notify-mode sub (should NOT try to drop non-existent snapshot)
SELECT pgr.unsubscribe('nm_q1');

-- Verify it's gone
SELECT count(*) AS sub_exists
FROM pgr.get_subscriptions() WHERE query_id = 'nm_q1';

-- 15. Unsubscribe delta-mode subs
SELECT pgr.unsubscribe('nm_q2');
SELECT pgr.unsubscribe('nm_q4');

-- Cleanup
DROP TABLE orders;
DROP EXTENSION pg_reactive;
