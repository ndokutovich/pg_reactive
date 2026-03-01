-- Test: advanced SQL query types — recursive CTEs, LATERAL joins, window functions
\set VERBOSITY terse
\set ON_ERROR_STOP on

CREATE EXTENSION pg_reactive;

----------------------------------------------------------------------
-- Test 1: WITH RECURSIVE (tree traversal)
----------------------------------------------------------------------

CREATE TABLE tree_nodes (
    id serial PRIMARY KEY,
    parent_id int REFERENCES tree_nodes(id),
    name text
);

INSERT INTO tree_nodes (id, parent_id, name) VALUES
    (1, NULL, 'root'),
    (2, 1, 'child_a'),
    (3, 1, 'child_b'),
    (4, 2, 'grandchild_a1'),
    (5, 3, 'grandchild_b1');
SELECT setval('tree_nodes_id_seq', 5);

-- Subscribe to recursive CTE
SELECT pgr.subscribe('adv_recursive', $q$
    WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, name::text AS path
        FROM tree_nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT tn.id, tn.parent_id, tn.name, t.path || ' > ' || tn.name
        FROM tree_nodes tn JOIN tree t ON tn.parent_id = t.id
    )
    SELECT id, name, path FROM tree ORDER BY id
$q$);

-- Verify snapshot has all 5 nodes
SELECT count(*) AS recursive_snap FROM pgr."_snap_adv_recursive";

-- Verify snapshot content is correct
SELECT * FROM pgr."_snap_adv_recursive" ORDER BY id;

-- INSERT a new grandchild — should add one row to the tree
INSERT INTO tree_nodes (id, parent_id, name) VALUES (6, 2, 'grandchild_a2');

-- Snapshot should now have 6 rows
SELECT count(*) AS recursive_after_insert FROM pgr."_snap_adv_recursive";

-- Verify the new row has correct path
SELECT name, path FROM pgr."_snap_adv_recursive" WHERE id = 6;

-- Verify snapshot matches query exactly (zero diff)
SELECT count(*) AS recursive_diff FROM (
    (WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, name::text AS path
        FROM tree_nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT tn.id, tn.parent_id, tn.name, t.path || ' > ' || tn.name
        FROM tree_nodes tn JOIN tree t ON tn.parent_id = t.id
    )
    SELECT id, name, path FROM tree ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_recursive")
) t;

-- Test 1 bidirectional diff: verify snapshot has no stale rows
SELECT count(*) AS recursive_bidi_diff FROM (
    (SELECT id, name, path FROM pgr."_snap_adv_recursive")
    EXCEPT
    (WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, name::text AS path
        FROM tree_nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT tn.id, tn.parent_id, tn.name, t.path || ' > ' || tn.name
        FROM tree_nodes tn JOIN tree t ON tn.parent_id = t.id
    )
    SELECT id, name, path FROM tree ORDER BY id)
) t;

-- DELETE an intermediate node's child — should remove it from path results
DELETE FROM tree_nodes WHERE id = 5;

SELECT count(*) AS recursive_after_delete FROM pgr."_snap_adv_recursive";

-- Verify snapshot still matches query
SELECT count(*) AS recursive_diff2 FROM (
    (WITH RECURSIVE tree AS (
        SELECT id, parent_id, name, name::text AS path
        FROM tree_nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT tn.id, tn.parent_id, tn.name, t.path || ' > ' || tn.name
        FROM tree_nodes tn JOIN tree t ON tn.parent_id = t.id
    )
    SELECT id, name, path FROM tree ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_recursive")
) t;

-- Cleanup
SELECT pgr.unsubscribe('adv_recursive');
DROP TABLE tree_nodes;

----------------------------------------------------------------------
-- Test 2: LATERAL join
----------------------------------------------------------------------

CREATE TABLE players (id serial PRIMARY KEY, name text);
CREATE TABLE scores (id serial PRIMARY KEY, player_id int REFERENCES players(id), score int, created_at timestamp DEFAULT now());

INSERT INTO players (id, name) VALUES (1, 'alice'), (2, 'bob'), (3, 'carol');
SELECT setval('players_id_seq', 3);

INSERT INTO scores (player_id, score, created_at) VALUES
    (1, 100, '2025-01-01'),
    (1, 150, '2025-01-02'),
    (2, 200, '2025-01-01'),
    (2, 180, '2025-01-02'),
    (3, 90,  '2025-01-01');

-- Subscribe to LATERAL subquery — latest score per player
SELECT pgr.subscribe('adv_lateral', $q$
    SELECT p.id, p.name, latest.score
    FROM players p,
    LATERAL (SELECT score FROM scores WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) latest
    ORDER BY p.id
$q$);

-- Verify snapshot: 3 players, each with their latest score
SELECT count(*) AS lateral_snap FROM pgr."_snap_adv_lateral";
SELECT * FROM pgr."_snap_adv_lateral" ORDER BY id;

-- Insert a new high score for alice — should update her latest
INSERT INTO scores (player_id, score, created_at) VALUES (1, 300, '2025-01-03');

-- Verify snapshot updated
SELECT * FROM pgr."_snap_adv_lateral" ORDER BY id;

-- Verify zero diff
SELECT count(*) AS lateral_diff FROM (
    (SELECT p.id, p.name, latest.score
     FROM players p,
     LATERAL (SELECT score FROM scores WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) latest
     ORDER BY p.id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_lateral")
) t;

-- Add a new player with a score — LATERAL should include them
INSERT INTO players (id, name) VALUES (4, 'dave');
INSERT INTO scores (player_id, score, created_at) VALUES (4, 250, '2025-01-01');

SELECT count(*) AS lateral_after_new_player FROM pgr."_snap_adv_lateral";

-- Verify zero diff
SELECT count(*) AS lateral_diff2 FROM (
    (SELECT p.id, p.name, latest.score
     FROM players p,
     LATERAL (SELECT score FROM scores WHERE player_id = p.id ORDER BY created_at DESC LIMIT 1) latest
     ORDER BY p.id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_lateral")
) t;

-- Cleanup
SELECT pgr.unsubscribe('adv_lateral');
DROP TABLE scores;
DROP TABLE players;

----------------------------------------------------------------------
-- Test 3: Window functions (ROW_NUMBER, DENSE_RANK)
----------------------------------------------------------------------

CREATE TABLE products (id serial PRIMARY KEY, title text, author_id int, price numeric);

INSERT INTO products (id, title, author_id, price) VALUES
    (1, 'Widget A', 10, 5.00),
    (2, 'Widget B', 10, 8.00),
    (3, 'Gadget C', 20, 3.00),
    (4, 'Gadget D', 20, 12.00);
SELECT setval('products_id_seq', 4);

-- Subscribe to window function query
SELECT pgr.subscribe('adv_window', $q$
    SELECT id, title, author_id,
           row_number() OVER (ORDER BY id) AS rn,
           dense_rank() OVER (PARTITION BY author_id ORDER BY id) AS dr
    FROM products ORDER BY id
$q$);

SELECT count(*) AS window_snap FROM pgr."_snap_adv_window";
SELECT * FROM pgr."_snap_adv_window" ORDER BY id;

-- INSERT new product — shifts row_number for all subsequent rows
INSERT INTO products (id, title, author_id, price) VALUES (5, 'Gadget E', 20, 7.00);

-- Verify snapshot matches query (window functions recalculated)
SELECT count(*) AS window_diff FROM (
    (SELECT id, title, author_id,
            row_number() OVER (ORDER BY id) AS rn,
            dense_rank() OVER (PARTITION BY author_id ORDER BY id) AS dr
     FROM products ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_window")
) t;

SELECT count(*) AS window_after_insert FROM pgr."_snap_adv_window";

-- DELETE a product — window values shift again
DELETE FROM products WHERE id = 2;

SELECT count(*) AS window_diff2 FROM (
    (SELECT id, title, author_id,
            row_number() OVER (ORDER BY id) AS rn,
            dense_rank() OVER (PARTITION BY author_id ORDER BY id) AS dr
     FROM products ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_window")
) t;

SELECT count(*) AS window_after_delete FROM pgr."_snap_adv_window";

-- Cleanup
SELECT pgr.unsubscribe('adv_window');
DROP TABLE products;

----------------------------------------------------------------------
-- Test 4: Window functions with LAG/LEAD
----------------------------------------------------------------------

CREATE TABLE events (id serial PRIMARY KEY, title text, event_date date);

INSERT INTO events (id, title, event_date) VALUES
    (1, 'Alpha', '2025-01-01'),
    (2, 'Beta',  '2025-02-01'),
    (3, 'Gamma', '2025-03-01');
SELECT setval('events_id_seq', 3);

-- Subscribe to LAG/LEAD query
SELECT pgr.subscribe('adv_laglead', $q$
    SELECT id, title,
           lag(title) OVER (ORDER BY id) AS prev_title,
           lead(title) OVER (ORDER BY id) AS next_title
    FROM events ORDER BY id
$q$);

SELECT count(*) AS laglead_snap FROM pgr."_snap_adv_laglead";
SELECT * FROM pgr."_snap_adv_laglead" ORDER BY id;

-- INSERT a new event — shifts lead/lag for neighbors
INSERT INTO events (id, title, event_date) VALUES (4, 'Delta', '2025-04-01');

-- Verify snapshot matches (Gamma now has next_title = 'Delta')
SELECT count(*) AS laglead_diff FROM (
    (SELECT id, title,
            lag(title) OVER (ORDER BY id) AS prev_title,
            lead(title) OVER (ORDER BY id) AS next_title
     FROM events ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_laglead")
) t;

SELECT count(*) AS laglead_after_insert FROM pgr."_snap_adv_laglead";

-- Verify specific values after insert
SELECT title, prev_title, next_title FROM pgr."_snap_adv_laglead" WHERE id = 3;

-- DELETE middle event — shifts lag/lead for remaining
DELETE FROM events WHERE id = 2;

SELECT count(*) AS laglead_diff2 FROM (
    (SELECT id, title,
            lag(title) OVER (ORDER BY id) AS prev_title,
            lead(title) OVER (ORDER BY id) AS next_title
     FROM events ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_laglead")
) t;

SELECT count(*) AS laglead_after_delete FROM pgr."_snap_adv_laglead";

-- After deleting Beta: Alpha(prev=NULL, next=Gamma), Gamma(prev=Alpha, next=Delta), Delta(prev=Gamma, next=NULL)
SELECT title, prev_title, next_title FROM pgr."_snap_adv_laglead" ORDER BY id;

-- Cleanup
SELECT pgr.unsubscribe('adv_laglead');
DROP TABLE events;

----------------------------------------------------------------------
-- Test 5: Multiple window functions + aggregate window
----------------------------------------------------------------------

CREATE TABLE sales (id serial PRIMARY KEY, region text, amount numeric);

INSERT INTO sales (id, region, amount) VALUES
    (1, 'east', 100),
    (2, 'east', 200),
    (3, 'west', 150),
    (4, 'west', 300);
SELECT setval('sales_id_seq', 4);

-- Subscribe to running total + partition rank
SELECT pgr.subscribe('adv_agg_window', $q$
    SELECT id, region, amount,
           sum(amount) OVER (PARTITION BY region ORDER BY id) AS running_total,
           rank() OVER (PARTITION BY region ORDER BY amount DESC) AS region_rank
    FROM sales ORDER BY id
$q$);

SELECT count(*) AS agg_window_snap FROM pgr."_snap_adv_agg_window";
SELECT * FROM pgr."_snap_adv_agg_window" ORDER BY id;

-- INSERT new sale — running totals and ranks recalculate
INSERT INTO sales (id, region, amount) VALUES (5, 'east', 500);

SELECT count(*) AS agg_window_diff FROM (
    (SELECT id, region, amount,
            sum(amount) OVER (PARTITION BY region ORDER BY id) AS running_total,
            rank() OVER (PARTITION BY region ORDER BY amount DESC) AS region_rank
     FROM sales ORDER BY id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_agg_window")
) t;

-- Verify the new row appears with correct running total
SELECT id, region, amount, running_total FROM pgr."_snap_adv_agg_window" WHERE id = 5;

-- Cleanup
SELECT pgr.unsubscribe('adv_agg_window');
DROP TABLE sales;

----------------------------------------------------------------------
-- Test 6: CASE expression with aggregate
----------------------------------------------------------------------

CREATE TABLE orders (id serial PRIMARY KEY, status text, total numeric);

INSERT INTO orders (id, status, total) VALUES
    (1, 'complete', 100),
    (2, 'pending',  50),
    (3, 'complete', 200),
    (4, 'cancelled', 75);
SELECT setval('orders_id_seq', 4);

SELECT pgr.subscribe('adv_case', $q$
    SELECT status,
           count(*) AS cnt,
           CASE WHEN count(*) > 1 THEN 'high' ELSE 'low' END AS volume
    FROM orders
    GROUP BY status
    ORDER BY status
$q$);

SELECT count(*) AS case_snap FROM pgr."_snap_adv_case";
SELECT * FROM pgr."_snap_adv_case" ORDER BY status;

-- Add another pending order — pending count goes from 1 to 2
INSERT INTO orders (id, status, total) VALUES (5, 'pending', 80);

-- Verify snapshot updated
SELECT count(*) AS case_diff FROM (
    (SELECT status,
            count(*) AS cnt,
            CASE WHEN count(*) > 1 THEN 'high' ELSE 'low' END AS volume
     FROM orders GROUP BY status ORDER BY status)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_case")
) t;

-- Pending should now show 'high' volume
SELECT status, cnt, volume FROM pgr."_snap_adv_case" WHERE status = 'pending';

-- Cleanup
SELECT pgr.unsubscribe('adv_case');
DROP TABLE orders;

----------------------------------------------------------------------
-- Test 7: COALESCE / NULLIF with LEFT JOIN
----------------------------------------------------------------------

CREATE TABLE departments (id serial PRIMARY KEY, name text);
CREATE TABLE employees (id serial PRIMARY KEY, dept_id int REFERENCES departments(id), name text, salary numeric);

INSERT INTO departments (id, name) VALUES (1, 'Engineering'), (2, 'Marketing'), (3, 'Sales');
SELECT setval('departments_id_seq', 3);

INSERT INTO employees (dept_id, name, salary) VALUES
    (1, 'Alice', 90000),
    (1, 'Bob',   80000),
    (2, 'Carol', 70000);

SELECT pgr.subscribe('adv_coalesce', $q$
    SELECT d.id, d.name AS dept,
           COALESCE(count(e.id), 0) AS headcount,
           COALESCE(avg(e.salary), 0) AS avg_salary
    FROM departments d
    LEFT JOIN employees e ON e.dept_id = d.id
    GROUP BY d.id, d.name
    ORDER BY d.id
$q$);

SELECT count(*) AS coalesce_snap FROM pgr."_snap_adv_coalesce";
SELECT * FROM pgr."_snap_adv_coalesce" ORDER BY id;

-- Add an employee to the empty Sales dept
INSERT INTO employees (dept_id, name, salary) VALUES (3, 'Dave', 60000);

SELECT count(*) AS coalesce_diff FROM (
    (SELECT d.id, d.name AS dept,
            COALESCE(count(e.id), 0) AS headcount,
            COALESCE(avg(e.salary), 0) AS avg_salary
     FROM departments d
     LEFT JOIN employees e ON e.dept_id = d.id
     GROUP BY d.id, d.name ORDER BY d.id)
    EXCEPT
    (SELECT * FROM pgr."_snap_adv_coalesce")
) t;

-- Sales dept should now show headcount=1
SELECT dept, headcount FROM pgr."_snap_adv_coalesce" WHERE id = 3;

-- Cleanup
SELECT pgr.unsubscribe('adv_coalesce');
DROP TABLE employees;
DROP TABLE departments;

----------------------------------------------------------------------
-- Final: verify all subscriptions cleaned up
----------------------------------------------------------------------

SELECT count(*) AS remaining_subs FROM pgr.get_subscriptions()
WHERE query_id LIKE 'adv_%';

DROP EXTENSION pg_reactive;
