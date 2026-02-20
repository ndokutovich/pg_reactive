-- Test: DML triggers auto-install, dirty tracking, DDL hook
CREATE EXTENSION pg_reactive;

-- Create test tables
CREATE TABLE t1 (id serial PRIMARY KEY, val text);
CREATE TABLE t2 (id serial PRIMARY KEY, val text);

-- Subscribe to a query on t1
SELECT pgr.subscribe('inv_q1', 'SELECT * FROM t1');

-- Verify triggers were auto-installed on t1
SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't1'::regclass
  AND tgname LIKE 'pgr_%';

-- t2 should have no triggers (not subscribed)
SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't2'::regclass
  AND tgname LIKE 'pgr_%';

-- Subscribe to a query that references both t1 and t2
SELECT pgr.subscribe('inv_q2', 'SELECT t1.id, t2.val FROM t1 JOIN t2 ON t1.id = t2.id');

-- Now t2 should also have triggers
SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't2'::regclass
  AND tgname LIKE 'pgr_%';

-- Record baseline invalidation count
SELECT value::bigint AS baseline FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

-- DML should work fine (triggers fire but just mark dirty)
INSERT INTO t1 (val) VALUES ('hello');
INSERT INTO t2 (val) VALUES ('world');
UPDATE t1 SET val = 'updated' WHERE id = 1;
DELETE FROM t2 WHERE id = 1;

-- Check invalidation count increased by 6
-- (INSERT t1 hits q1+q2=2, INSERT t2 hits q2=1, UPDATE t1 hits q1+q2=2, DELETE t2 hits q2=1)
SELECT value::bigint - :baseline AS new_invalidations
FROM pgr.stats() WHERE metric = 'total_invalidations';

-- Unsubscribe inv_q2 — t2 triggers should be removed since only inv_q2 references t2
SELECT pgr.unsubscribe('inv_q2');

-- t2 triggers should be gone
SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't2'::regclass
  AND tgname LIKE 'pgr_%';

-- t1 triggers should still be there (inv_q1 still references it)
SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't1'::regclass
  AND tgname LIKE 'pgr_%';

-- Unsubscribe inv_q1 — t1 triggers should now be removed
SELECT pgr.unsubscribe('inv_q1');

SELECT count(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid = 't1'::regclass
  AND tgname LIKE 'pgr_%';

-- TRUNCATE DDL hook test: subscribe, truncate, check invalidation
SELECT pgr.subscribe('inv_q3', 'SELECT * FROM t1');

-- Record current invalidation count before TRUNCATE
SELECT value::bigint AS pre_truncate FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

TRUNCATE t1;

-- Invalidation count should have increased by 1
SELECT value::bigint - :pre_truncate AS truncate_invalidations
FROM pgr.stats() WHERE metric = 'total_invalidations';

-- Cleanup
SELECT pgr.unsubscribe('inv_q3');
DROP TABLE t2;
DROP TABLE t1;
DROP EXTENSION pg_reactive;
