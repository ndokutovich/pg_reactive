# Test: TRUNCATE (DDL hook) interleaved with INSERT (trigger path)
# Verifies that the ProcessUtility hook and trigger-based invalidation
# don't conflict when operating on the same tracked table concurrently.

setup
{
    CREATE EXTENSION IF NOT EXISTS pg_reactive;
    CREATE TABLE cinv (id serial PRIMARY KEY, val text);
    SELECT pgr.subscribe('cinv_q', 'SELECT * FROM cinv');
    -- Seed some data so TRUNCATE has work to do
    INSERT INTO cinv (val) VALUES ('seed1'), ('seed2'), ('seed3');
}

teardown
{
    SELECT pgr.unsubscribe('cinv_q');
    DROP TABLE cinv;
    DROP EXTENSION pg_reactive;
}

session "s1"
step "s1_insert1"   { INSERT INTO cinv (val) VALUES ('s1_a'); }
step "s1_insert2"   { INSERT INTO cinv (val) VALUES ('s1_b'); }
step "s1_insert3"   { INSERT INTO cinv (val) VALUES ('s1_c'); }
step "s1_check"     { SELECT count(*) FROM cinv; }

session "s2"
step "s2_truncate"  { TRUNCATE cinv; }
step "s2_insert1"   { INSERT INTO cinv (val) VALUES ('s2_after_trunc'); }
step "s2_check"     { SELECT count(*) FROM cinv; }

# TRUNCATE between inserts
permutation "s1_insert1" "s2_truncate" "s1_insert2" "s2_insert1" "s1_insert3" "s1_check" "s2_check"

# Insert then truncate then more inserts
permutation "s1_insert1" "s1_insert2" "s2_truncate" "s2_insert1" "s1_insert3" "s1_check" "s2_check"

# TRUNCATE first
permutation "s2_truncate" "s1_insert1" "s2_insert1" "s1_insert2" "s1_insert3" "s1_check" "s2_check"
