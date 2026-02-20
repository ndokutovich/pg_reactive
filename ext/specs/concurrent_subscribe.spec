# Test: subscribe/unsubscribe concurrent with DML
# One session manages subscriptions while another does DML.
# Verifies shared memory hash table integrity under concurrent access.

setup
{
    CREATE EXTENSION IF NOT EXISTS pg_reactive;
    CREATE TABLE csub (id serial PRIMARY KEY, val text);
}

teardown
{
    SELECT pgr.unsubscribe('csub_q1');
    SELECT pgr.unsubscribe('csub_q2');
    DROP TABLE csub;
    DROP EXTENSION pg_reactive;
}

session "s1"
step "s1_sub1"      { SELECT pgr.subscribe('csub_q1', 'SELECT * FROM csub'); }
step "s1_sub2"      { SELECT pgr.subscribe('csub_q2', 'SELECT * FROM csub WHERE val IS NOT NULL'); }
step "s1_unsub1"    { SELECT pgr.unsubscribe('csub_q1'); }
step "s1_resub1"    { SELECT pgr.subscribe('csub_q1', 'SELECT * FROM csub'); }
step "s1_unsub2"    { SELECT pgr.unsubscribe('csub_q2'); }

session "s2"
step "s2_insert1"   { INSERT INTO csub (val) VALUES ('row1'); }
step "s2_insert2"   { INSERT INTO csub (val) VALUES ('row2'); }
step "s2_update"    { UPDATE csub SET val = 'modified' WHERE val = 'row1'; }
step "s2_delete"    { DELETE FROM csub WHERE val = 'row2'; }

# DML while subscribing
permutation "s1_sub1" "s2_insert1" "s1_sub2" "s2_insert2" "s1_unsub1" "s2_update" "s1_resub1" "s2_delete" "s1_unsub2"

# DML before any subscription
permutation "s2_insert1" "s1_sub1" "s2_insert2" "s1_sub2" "s2_update" "s1_unsub1" "s2_delete" "s1_resub1" "s1_unsub2"

# Rapid subscribe/unsubscribe interleaved with DML
permutation "s1_sub1" "s1_unsub1" "s2_insert1" "s1_resub1" "s2_insert2" "s1_sub2" "s2_update" "s1_unsub2" "s2_delete"
