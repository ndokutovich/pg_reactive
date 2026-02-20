-- Test: subscribe and unsubscribe functions
CREATE EXTENSION pg_reactive;

-- Create test tables
CREATE TABLE orders (id serial PRIMARY KEY, customer_id int, total numeric, status text);
CREATE TABLE customers (id serial PRIMARY KEY, name text);

-- Subscribe to a simple query
SELECT pgr.subscribe('q1', 'SELECT * FROM orders WHERE status = ''pending''');

-- Verify it appears in subscriptions
SELECT query_id, num_tables FROM pgr.subscriptions;

-- Subscribe to a multi-table query
SELECT pgr.subscribe('q2', 'SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id');

-- Should now have 2 subscriptions
SELECT query_id, num_tables FROM pgr.subscriptions ORDER BY query_id;

-- active_subscriptions should be 2
SELECT metric, value FROM pgr.stats() WHERE metric = 'active_subscriptions';

-- Unsubscribe q1
SELECT pgr.unsubscribe('q1');

-- Only q2 should remain
SELECT query_id, num_tables FROM pgr.subscriptions;

-- Unsubscribe non-existent should return false
SELECT pgr.unsubscribe('does_not_exist');

-- Re-subscribe q1 (should work, updating the entry)
SELECT pgr.subscribe('q1', 'SELECT * FROM orders');

SELECT query_id, num_tables FROM pgr.subscriptions ORDER BY query_id;

-- active_subscriptions should be 2 again after re-subscribe
SELECT metric, value FROM pgr.stats() WHERE metric = 'active_subscriptions';

-- Cleanup
SELECT pgr.unsubscribe('q1');
SELECT pgr.unsubscribe('q2');

-- Should be empty
SELECT count(*) FROM pgr.subscriptions;

DROP TABLE customers;
DROP TABLE orders;
DROP EXTENSION pg_reactive;
