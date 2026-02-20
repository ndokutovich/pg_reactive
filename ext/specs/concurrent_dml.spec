# Test: concurrent DML on a tracked table
# Two sessions perform INSERT/UPDATE/DELETE on the same table that has
# an active subscription. Verifies no deadlocks and snapshot consistency.

setup
{
    CREATE EXTENSION IF NOT EXISTS pg_reactive;
    CREATE TABLE cdml (id serial PRIMARY KEY, val text);
    SELECT pgr.subscribe('cdml_q', 'SELECT * FROM cdml');
}

teardown
{
    SELECT pgr.unsubscribe('cdml_q');
    DROP TABLE cdml;
    DROP EXTENSION pg_reactive;
}

session "s1"
step "s1_insert"    { INSERT INTO cdml (val) VALUES ('s1_row'); }
step "s1_update"    { UPDATE cdml SET val = 's1_updated' WHERE val = 's1_row'; }
step "s1_delete"    { DELETE FROM cdml WHERE val = 's1_updated'; }
step "s1_insert2"   { INSERT INTO cdml (val) VALUES ('s1_final'); }

session "s2"
step "s2_insert"    { INSERT INTO cdml (val) VALUES ('s2_row'); }
step "s2_update"    { UPDATE cdml SET val = 's2_updated' WHERE val = 's2_row'; }
step "s2_delete"    { DELETE FROM cdml WHERE val = 's2_updated'; }
step "s2_insert2"   { INSERT INTO cdml (val) VALUES ('s2_final'); }

# Interleaved DML: both sessions insert, update, delete concurrently
permutation "s1_insert" "s2_insert" "s1_update" "s2_update" "s1_delete" "s2_delete" "s1_insert2" "s2_insert2"

# Alternating pattern
permutation "s1_insert" "s1_update" "s2_insert" "s2_update" "s1_delete" "s2_delete" "s1_insert2" "s2_insert2"

# s2 first
permutation "s2_insert" "s1_insert" "s2_update" "s1_update" "s2_delete" "s1_delete" "s2_insert2" "s1_insert2"
