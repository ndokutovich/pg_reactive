# Round 37 F1 (HIGH): the proxy's audience/mode gate must read the
# TRANSACTIONAL catalog (pgr.subscription_meta over pgr.persisted_subscriptions),
# never the non-transactional shmem hash (pgr.get_subscriptions).
#
# Shared memory is mutated by pgr.subscribe() out-of-transaction and is
# immediately visible to every backend. So a re-subscribe that flips an
# audience-bound (protected) subscription to public INSIDE an uncommitted
# transaction is briefly visible to a concurrent session as public — an
# audience bypass for the WS-connect gate, even though the change is later
# committed OR rolled back.
#
# This spec pins the contract:
#   proxy_gate  (subscription_meta -> persisted_subscriptions, MVCC) must keep
#               returning the committed audience while another session's
#               re-subscribe is in flight, and after that session rolls back.
#   shmem_view  (get_subscriptions -> shmem) is shown alongside ONLY to
#               document why the proxy must not use it: it leaks the
#               uncommitted NULL mid-transaction.
#
# NB: step bodies avoid '{...}' JSON literals and SQL -- comments; the
# isolationtester block lexer would mis-scan a '}' or a quote inside them.

setup
{
    CREATE EXTENSION IF NOT EXISTS pg_reactive;
    CREATE TABLE aud_t (id int PRIMARY KEY);
    SELECT (pgr.subscribe('aud_q', 'SELECT id FROM aud_t', 'delta', jsonb_build_object('sub', 'victim')))->>'status' AS baseline;
}

teardown
{
    SELECT pgr.unsubscribe('aud_q');
    DROP TABLE aud_t;
    DROP EXTENSION pg_reactive;
}

session "s1"
step "s1_begin"    { BEGIN; }
step "s1_repub"    { SELECT (pgr.subscribe('aud_q', 'SELECT id FROM aud_t', 'delta', NULL))->>'status' AS repub; }
step "s1_rollback" { ROLLBACK; }

session "s2"
step "s2_read"
{
    SELECT
        (SELECT audience::text FROM pgr.subscription_meta('aud_q')) AS proxy_gate,
        (SELECT audience::text FROM pgr.get_subscriptions() WHERE query_id = 'aud_q') AS shmem_view;
}

permutation "s1_begin" "s1_repub" "s2_read" "s1_rollback" "s2_read"
