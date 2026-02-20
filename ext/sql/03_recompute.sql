-- Test: recompute engine + NOTIFY deltas
CREATE EXTENSION pg_reactive;

CREATE TABLE items (id serial PRIMARY KEY, name text, price numeric);

-- Subscribe to a query
SELECT pgr.subscribe('rc_q1', 'SELECT * FROM items');

-- Verify snapshot table was created
SELECT count(*) AS snap_exists
FROM pg_tables
WHERE schemaname = 'pgr' AND tablename = '_snap_rc_q1';

-- Snapshot should be empty (no rows in items yet)
SELECT count(*) AS snap_rows FROM pgr."_snap_rc_q1";

-- INSERT should trigger recompute synchronously via trigger
INSERT INTO items (name, price) VALUES ('apple', 1.50);

-- Snapshot should now have the inserted row
SELECT count(*) AS snap_rows FROM pgr."_snap_rc_q1";

-- Insert more rows
INSERT INTO items (name, price) VALUES ('banana', 0.75);
SELECT count(*) AS snap_rows FROM pgr."_snap_rc_q1";

-- UPDATE should be reflected in snapshot
UPDATE items SET price = 2.00 WHERE name = 'apple';
SELECT name, price FROM pgr."_snap_rc_q1" WHERE name = 'apple';

-- DELETE should be reflected in snapshot
DELETE FROM items WHERE name = 'banana';
SELECT count(*) AS snap_rows FROM pgr."_snap_rc_q1";

-- Verify remaining snapshot contents match the actual query
SELECT i.id, i.name, i.price FROM items i
EXCEPT
SELECT s.id, s.name, s.price FROM pgr."_snap_rc_q1" s;

SELECT s.id, s.name, s.price FROM pgr."_snap_rc_q1" s
EXCEPT
SELECT i.id, i.name, i.price FROM items i;

-- Unsubscribe should drop snapshot
SELECT pgr.unsubscribe('rc_q1');

SELECT count(*) AS snap_exists
FROM pg_tables
WHERE schemaname = 'pgr' AND tablename = '_snap_rc_q1';

-- Cleanup
DROP TABLE items;
DROP EXTENSION pg_reactive;
