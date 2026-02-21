-- Test column-level dependency tracking (Strategy 2)
-- Only invalidate when DML touches columns the query actually uses.

CREATE EXTENSION pg_reactive;

-- Setup
CREATE TABLE coltrack (id serial PRIMARY KEY, name text, val int, status text);
INSERT INTO coltrack (name, val, status) VALUES
    ('alice', 10, 'active'),
    ('bob', 20, 'inactive'),
    ('charlie', 30, 'active');

-- Subscribe to a query that only uses id and name columns
SELECT pgr.subscribe('ct_partial', 'SELECT id, name FROM coltrack');

-- Verify snapshot was created
SELECT count(*) AS snapshot_rows FROM pgr."_snap_ct_partial";

-- Capture baseline invalidation count
SELECT value::bigint AS inv_before FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

-- UPDATE a column NOT used by the query (val) — should NOT invalidate
UPDATE coltrack SET val = 99 WHERE id = 1;

-- Check invalidation count did not increase
SELECT value::bigint - :inv_before AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

-- Verify snapshot unchanged (recompute did not run for val-only update)
SELECT count(*) AS snapshot_rows FROM pgr."_snap_ct_partial";

-- Now UPDATE a column that IS used by the query (name) — SHOULD invalidate
SELECT value::bigint AS inv_before2 FROM pgr.stats() WHERE metric = 'total_invalidations' \gset
UPDATE coltrack SET name = 'alice_updated' WHERE id = 1;
SELECT value::bigint - :inv_before2 AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

-- Snapshot should reflect the update
SELECT * FROM pgr."_snap_ct_partial" ORDER BY id;

-- Clean up first subscription
SELECT pgr.unsubscribe('ct_partial');

-- Test 2: SELECT * should track all columns
SELECT pgr.subscribe('ct_star', 'SELECT * FROM coltrack');

SELECT value::bigint AS inv_before3 FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

-- UPDATE on val column SHOULD invalidate (SELECT * = all columns)
UPDATE coltrack SET val = 999 WHERE id = 2;
SELECT value::bigint - :inv_before3 AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

SELECT pgr.unsubscribe('ct_star');

-- Test 3: WHERE clause column tracking
SELECT pgr.subscribe('ct_where', 'SELECT id, name FROM coltrack WHERE status = ''active''');

SELECT value::bigint AS inv_before4 FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

-- UPDATE status column (used in WHERE) — SHOULD invalidate
UPDATE coltrack SET status = 'paused' WHERE id = 3;
SELECT value::bigint - :inv_before4 AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

-- Snapshot should now exclude charlie (status no longer 'active')
SELECT * FROM pgr."_snap_ct_where" ORDER BY id;

SELECT pgr.unsubscribe('ct_where');

-- Test 4: INSERT always invalidates (regardless of column tracking)
SELECT pgr.subscribe('ct_insert', 'SELECT id, name FROM coltrack');

SELECT value::bigint AS inv_before5 FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

INSERT INTO coltrack (name, val, status) VALUES ('diana', 40, 'active');
SELECT value::bigint - :inv_before5 AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

SELECT pgr.unsubscribe('ct_insert');

-- Test 5: DELETE always invalidates
SELECT pgr.subscribe('ct_delete', 'SELECT id, name FROM coltrack');

SELECT value::bigint AS inv_before6 FROM pgr.stats() WHERE metric = 'total_invalidations' \gset

DELETE FROM coltrack WHERE id = 4;
SELECT value::bigint - :inv_before6 AS inv_delta FROM pgr.stats() WHERE metric = 'total_invalidations';

SELECT pgr.unsubscribe('ct_delete');

-- Cleanup
DROP TABLE coltrack;
DROP EXTENSION pg_reactive;
