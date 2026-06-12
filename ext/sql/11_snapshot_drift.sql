-- Test: query-shape drift under a stable query_id must not crash the delta path.
--
-- Two layers protect the EXCEPT-based delta against a snapshot whose column
-- shape no longer matches the live query:
--   1. (round 39 batch-2 F-SNAP) pgr.subscribe DROPs and rebuilds pgr._snap_<qid>
--      on every (re-)subscribe, so re-subscribing the same query_id with a
--      different projection can never leave a stale-shaped (or stale-content)
--      snapshot behind. This also closes a cross-tenant leak where a fresh
--      connection read the previous query's rows from the un-rebuilt snapshot.
--   2. As a runtime safety net for drift that arises WITHOUT a re-subscribe
--      (e.g. a snapshot that survived an older deploy, or a column type change),
--      the next recompute detects the column mismatch, rebuilds the snapshot,
--      and emits an overflow resync instead of aborting the triggering DML with
--      "each EXCEPT query must have the same number of columns".
CREATE EXTENSION pg_reactive;

CREATE TABLE drift_t (id serial PRIMARY KEY, a int);
INSERT INTO drift_t (a) VALUES (10), (20);

-- Subscribe with a 2-column projection. Snapshot _snap_drift_q is 2 columns.
SELECT pgr.subscribe('drift_q', 'SELECT id, a FROM drift_t');

SELECT count(*) AS snap_cols_before
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- Re-subscribe under the SAME query_id with a 3-column projection. The F-SNAP
-- fix rebuilds the snapshot here, so it is immediately the live 3-column shape
-- (no stale 2-column snapshot, no drift to detect at recompute time).
SELECT pgr.subscribe('drift_q', 'SELECT id, a, a * 2 AS doubled FROM drift_t');

SELECT count(*) AS snap_cols_after_resubscribe
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- An ordinary DML now produces a normal delta against the rebuilt snapshot.
INSERT INTO drift_t (a) VALUES (30);

-- Safety net: force a snapshot whose shape drifted WITHOUT a re-subscribe (the
-- cross-deploy / schema-change case) by dropping a column directly, then a DML
-- must not crash — the recompute detects the mismatch, rebuilds, and resyncs.
ALTER TABLE pgr."_snap_drift_q" DROP COLUMN doubled;

SELECT count(*) AS snap_cols_drifted
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- Pre-fix this INSERT aborts with the EXCEPT column-count error; post-fix it
-- succeeds and the snapshot is rebuilt to the live 3-column shape.
INSERT INTO drift_t (a) VALUES (40);

SELECT count(*) AS snap_cols_rebuilt
FROM information_schema.columns
WHERE table_schema = 'pgr' AND table_name = '_snap_drift_q';

-- Snapshot tracks the live result exactly — no leftover or missing rows.
SELECT id, a, a * 2 AS doubled FROM drift_t
EXCEPT
SELECT id, a, doubled FROM pgr."_snap_drift_q";

SELECT pgr.unsubscribe('drift_q');
DROP TABLE drift_t;
DROP EXTENSION pg_reactive;
