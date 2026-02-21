-- Test: NOTIFY overflow handling for large payloads
CREATE EXTENSION pg_reactive;

-- Create a table with a large text column
CREATE TABLE big_data (id serial PRIMARY KEY, payload text);

-- Subscribe
SELECT pgr.subscribe('overflow_q', 'SELECT id, payload FROM big_data');

-- Insert a small row — should produce a normal delta notification
INSERT INTO big_data (payload) VALUES ('small');

-- Check snapshot updated
SELECT count(*) AS snap_rows FROM pgr."_snap_overflow_q";

-- Insert a row with payload > 7800 bytes to trigger overflow
-- generate_series produces ~8000+ bytes of JSON
INSERT INTO big_data (payload) VALUES (repeat('X', 8000));

-- Snapshot should still be updated even with overflow
SELECT count(*) AS snap_rows FROM pgr."_snap_overflow_q";

-- Verify snapshot matches actual data
SELECT count(*) AS diff_count FROM (
  (SELECT id, payload FROM big_data)
  EXCEPT
  (SELECT id, payload FROM pgr."_snap_overflow_q")
) t;

-- Cleanup
SELECT pgr.unsubscribe('overflow_q');
DROP TABLE big_data;
DROP EXTENSION pg_reactive;
