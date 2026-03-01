-- Test: batch invalidation — multiple DML in one transaction produces
-- a single recompute per unique query_id instead of one per trigger fire.
\set VERBOSITY terse
\set ON_ERROR_STOP on

CREATE EXTENSION pg_reactive;

-- 1. Verify the GUC exists and defaults to ON
SHOW pg_reactive.batch_invalidation;

-- Setup
CREATE TABLE batch_test (id serial PRIMARY KEY, val text);
SELECT pgr.subscribe('bt_q1', 'SELECT id, val FROM batch_test ORDER BY id');

-- Capture baseline recompute count
SELECT value::bigint AS rc_before
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

-- 2. Multiple DML in one transaction should batch into a single recompute
BEGIN;
INSERT INTO batch_test (val) VALUES ('a');
INSERT INTO batch_test (val) VALUES ('b');
INSERT INTO batch_test (val) VALUES ('c');
COMMIT;

-- Should have exactly 1 recompute (batched), not 3
SELECT value::bigint - :rc_before AS recomputes_after_batch
FROM pgr.stats() WHERE metric = 'total_recomputes';

-- 3. Snapshot should reflect all 3 rows (recompute ran once at commit)
SELECT count(*) AS snap_rows FROM pgr."_snap_bt_q1";
SELECT * FROM pgr."_snap_bt_q1" ORDER BY id;

-- 4. Verify snapshot matches actual query
SELECT count(*) AS diff FROM (
  (SELECT id, val FROM batch_test ORDER BY id)
  EXCEPT
  (SELECT * FROM pgr."_snap_bt_q1")
) t;

-- Capture baseline before next test
SELECT value::bigint AS rc_before2
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

-- 5. Mixed DML in one transaction (INSERT + UPDATE + DELETE)
BEGIN;
INSERT INTO batch_test (val) VALUES ('d');
UPDATE batch_test SET val = 'A' WHERE val = 'a';
DELETE FROM batch_test WHERE val = 'b';
COMMIT;

-- Still only 1 recompute (same query_id, batched)
SELECT value::bigint - :rc_before2 AS recomputes_mixed
FROM pgr.stats() WHERE metric = 'total_recomputes';

-- Snapshot should match actual data
SELECT count(*) AS diff FROM (
  (SELECT id, val FROM batch_test ORDER BY id)
  EXCEPT
  (SELECT * FROM pgr."_snap_bt_q1")
) t;

-- 6. Autocommit statements (implicit single-stmt transactions) still work
SELECT value::bigint AS rc_before3
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

INSERT INTO batch_test (val) VALUES ('e');

SELECT value::bigint - :rc_before3 AS recomputes_autocommit
FROM pgr.stats() WHERE metric = 'total_recomputes';

SELECT count(*) AS diff FROM (
  (SELECT id, val FROM batch_test ORDER BY id)
  EXCEPT
  (SELECT * FROM pgr."_snap_bt_q1")
) t;

-- 7. ABORT should discard dirty list — no recompute
SELECT value::bigint AS rc_before4
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

BEGIN;
INSERT INTO batch_test (val) VALUES ('should_not_appear');
ROLLBACK;

SELECT value::bigint - :rc_before4 AS recomputes_after_abort
FROM pgr.stats() WHERE metric = 'total_recomputes';

-- Snapshot should be unchanged
SELECT count(*) AS diff FROM (
  (SELECT id, val FROM batch_test ORDER BY id)
  EXCEPT
  (SELECT * FROM pgr."_snap_bt_q1")
) t;

-- 8. Test with batch_invalidation OFF (inline recompute, old behavior)
SET pg_reactive.batch_invalidation = off;
SHOW pg_reactive.batch_invalidation;

SELECT value::bigint AS rc_before5
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

BEGIN;
INSERT INTO batch_test (val) VALUES ('f');
INSERT INTO batch_test (val) VALUES ('g');
COMMIT;

-- With batch OFF, each trigger fires recompute inline = 2 recomputes
SELECT value::bigint - :rc_before5 AS recomputes_nobatch
FROM pgr.stats() WHERE metric = 'total_recomputes';

-- Snapshot should still be correct regardless
SELECT count(*) AS diff FROM (
  (SELECT id, val FROM batch_test ORDER BY id)
  EXCEPT
  (SELECT * FROM pgr."_snap_bt_q1")
) t;

-- Restore default
SET pg_reactive.batch_invalidation = on;

-- 9. Two subscriptions on the same table — both batched
SELECT pgr.subscribe('bt_q2', 'SELECT val FROM batch_test');

SELECT value::bigint AS rc_before6
FROM pgr.stats() WHERE metric = 'total_recomputes' \gset

BEGIN;
INSERT INTO batch_test (val) VALUES ('h');
INSERT INTO batch_test (val) VALUES ('i');
COMMIT;

-- 2 recomputes: one for bt_q1, one for bt_q2 (both batched)
SELECT value::bigint - :rc_before6 AS recomputes_two_subs
FROM pgr.stats() WHERE metric = 'total_recomputes';

-- Cleanup
SELECT pgr.unsubscribe('bt_q1');
SELECT pgr.unsubscribe('bt_q2');
DROP TABLE batch_test;
DROP EXTENSION pg_reactive;
