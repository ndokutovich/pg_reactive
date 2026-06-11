-- pg_reactive 0.1.4 -> 0.1.5
--
-- Adds pgr.subscription_meta(query_id): the TRANSACTIONAL audience/mode source
-- the WebSocket proxy gate reads (round 37 F1 — the proxy must not read the
-- non-transactional shmem via pgr.get_subscriptions()).
--
-- Why this is its own version: 0.1.4 originally shipped subscription_meta
-- in-place, so databases ALREADY at 0.1.4 (persistent production) never received
-- it on `ALTER EXTENSION pg_reactive UPDATE` — there was no 0.1.4->0.1.4 path.
-- The new proxy calls subscriptionMeta() unconditionally, so on such a database
-- every WS/presence request 503s (the function does not exist). 0.1.5 makes the
-- function a proper version delta so every 0.1.4 database can upgrade into it.
--
-- CREATE OR REPLACE (not plain CREATE) because the transient in-place 0.1.4
-- already created the function on some databases; OR REPLACE upgrades those
-- cleanly while creating it where it is absent. The function becomes an
-- extension member either way.

CREATE OR REPLACE FUNCTION pgr.subscription_meta(p_query_id text)
RETURNS TABLE(mode text, audience jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pgr
AS $fn$
    SELECT ps.mode, ps.audience
    FROM pgr.persisted_subscriptions ps
    WHERE ps.query_id = p_query_id;
$fn$;

REVOKE EXECUTE ON FUNCTION pgr.subscription_meta(text) FROM PUBLIC;

COMMENT ON FUNCTION pgr.get_subscriptions() IS
    'List all active (in-shmem) subscriptions. Distinct from pgr.persisted_subscriptions which is the durable catalog. '
    'NOT a security source: shmem is non-transactional. The proxy audience gate uses pgr.subscription_meta instead.';

COMMENT ON FUNCTION pgr.subscription_meta(text) IS
    'Transactional mode/audience lookup over pgr.persisted_subscriptions for the WebSocket proxy audience gate. '
    'Reads the committed catalog (MVCC), so an uncommitted or rolled-back re-subscribe never leaks to the gate (round 37 F1).';
