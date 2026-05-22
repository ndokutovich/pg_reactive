-- Test: query-shape drift under a stable query_id must not crash the delta path.
--
-- Regression for the snapshot/EXCEPT column-count-drift bug: pgr.subscribe
-- creates pgr._snap_<qid> with CREATE ... IF NOT EXISTS, so re-subscribing the
-- same query_id with a different projection leaves the snapshot frozen in its
-- old shape. The next recompute then runs
--   (SELECT * FROM _pgr_recompute) EXCEPT (SELECT * FROM pgr."_snap_<qid>")
-- with a mismatched column count and PostgreSQL aborts the triggering DML with
--   ERROR: each EXCEPT query must have the same number of columns
-- The durable fix detects the drift, rebuilds the snapshot, and emits a resync.
CREATE EXTENSION pg_reactive;

CREATE TABLE drift_t (id serial PRIMARY KEY, a int);
INSERT INTO drift_t (a) VALUES (10), (20);

-- Subscribe with a 2-column projection. Snapshot _snap_drift_q is 2 columns.
SELECT pgr.subscribe('drift_q', 'SELECT id, a FROM drift_t');

SELECT count(*) AS snap_cols_before
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- Re-subscribe under the SAME query_id with a 3-column projection.
SELECT pgr.subscribe('drift_q', 'SELECT id, a, a * 2 AS doubled FROM drift_t');

-- DML triggers recompute. _pgr_recompute is 3-col, the snapshot is still 2-col.
-- Pre-fix this INSERT aborts with the EXCEPT error; post-fix it succeeds.
INSERT INTO drift_t (a) VALUES (30);

-- The snapshot must have been rebuilt to the live 3-column shape.
SELECT count(*) AS snap_cols_after
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- A subsequent DML produces an ordinary delta against the rebuilt snapshot.
INSERT INTO drift_t (a) VALUES (40);

-- Snapshot tracks the live result exactly — no leftover or missing rows.
SELECT id, a, a * 2 AS doubled FROM drift_t
EXCEPT
SELECT id, a, doubled FROM pgr."_snap_drift_q";

SELECT pgr.unsubscribe('drift_q');
DROP TABLE drift_t;
DROP EXTENSION pg_reactive;
