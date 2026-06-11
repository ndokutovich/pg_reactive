-- 12_rollback_journal: shmem mutations are reverted on (sub)transaction abort.
--
-- Shared memory is not transactional; the before-image journal in
-- dependency.c must undo add/update/remove/eviction when the transaction or
-- subtransaction that made them aborts. Covers Codex round-36 audit #1
-- (audience must not leak via a rolled-back re-subscribe) and #6 (no orphan
-- on a rolled-back subscribe).
CREATE EXTENSION IF NOT EXISTS pg_reactive;
CREATE TABLE jt (id int primary key);

-- Baseline: a protected (audience-bound) subscription, committed.
SELECT (pgr.subscribe('j_aud', 'SELECT id FROM jt', 'delta', '{"sub":"42"}'))->>'status' AS setup;

-- #1 update-rollback: re-subscribe the SAME id to public (no audience) then
-- abort. The committed audience must survive — the proxy must never see the
-- uncommitted public value.
BEGIN;
SELECT (pgr.subscribe('j_aud', 'SELECT id FROM jt', 'delta', NULL))->>'status' AS reaudience;
ROLLBACK;
SELECT query_id, audience FROM pgr.get_subscriptions() WHERE query_id = 'j_aud';

-- #2 unsubscribe-rollback: a rolled-back unsubscribe leaves the entry intact.
BEGIN;
SELECT pgr.unsubscribe('j_aud') AS unsub;
ROLLBACK;
SELECT count(*) AS aud_present FROM pgr.get_subscriptions() WHERE query_id = 'j_aud';

-- #3 savepoint: ROLLBACK TO undoes only the inner subscribe; the outer one,
-- committed with the transaction, survives.
BEGIN;
SELECT (pgr.subscribe('j_q', 'SELECT id FROM jt', 'delta', NULL))->>'status' AS outer_sub;
SAVEPOINT s1;
SELECT (pgr.subscribe('j_r', 'SELECT id FROM jt', 'delta', NULL))->>'status' AS inner_sub;
ROLLBACK TO SAVEPOINT s1;
COMMIT;
SELECT query_id FROM pgr.get_subscriptions() WHERE query_id IN ('j_q', 'j_r') ORDER BY query_id;

-- #4 new-add rollback: a rolled-back fresh subscribe leaves no orphan.
BEGIN;
SELECT (pgr.subscribe('j_na', 'SELECT id FROM jt', 'delta', NULL))->>'status' AS na_sub;
ROLLBACK;
SELECT count(*) AS na_present FROM pgr.get_subscriptions() WHERE query_id = 'j_na';

-- Cleanup
SELECT pgr.unsubscribe('j_aud') AS cleanup_aud;
SELECT pgr.unsubscribe('j_q') AS cleanup_q;
DROP TABLE jt CASCADE;
