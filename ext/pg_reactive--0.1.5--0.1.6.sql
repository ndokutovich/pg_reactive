-- pg_reactive 0.1.5 -> 0.1.6
--
-- Generation-based immediate revocation of stale WebSocket connections
-- (round 39 batch-2 F1/F2/F3). Every subscribe/unsubscribe bumps a monotonic
-- generation, recorded in the catalog and announced on the NOTIFY channel as
-- {"type":"resubscribed","query_id":...,"gen":N}. The proxy binds each
-- connection to the generation it authorized against and immediately revokes
-- any connection older than N — closing the audience-change leak for deltas
-- (the announcement is ordered before them in commit order), for
-- presence/broadcast (no DML needed to trigger revocation), and the snapshot
-- TOCTOU (the proxy reads metadata + snapshot atomically per generation).

CREATE SEQUENCE IF NOT EXISTS pgr.subscription_generation_seq;
REVOKE ALL ON SEQUENCE pgr.subscription_generation_seq FROM PUBLIC;

ALTER TABLE pgr.persisted_subscriptions
    ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;

-- _subscribe_internal gains the generation so the C path stamps it into the
-- shmem entry — and therefore into EVERY NOTIFY this query later emits. That is
-- what lets the proxy drop a delta computed from a re-registered (new-epoch)
-- query before it reaches an old-epoch connection, even though the shmem write
-- happens in the non-transactional window before the subscribe commits. The
-- signature changes, so drop+create and re-REVOKE from PUBLIC (invariant 14).
DROP FUNCTION IF EXISTS pgr._subscribe_internal(text, text, text, jsonb);
CREATE FUNCTION pgr._subscribe_internal(
    query_id text,
    query text,
    mode text DEFAULT 'delta',
    audience jsonb DEFAULT NULL,
    generation bigint DEFAULT 0
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'pgr_subscribe'
LANGUAGE C;
REVOKE EXECUTE ON FUNCTION pgr._subscribe_internal(text, text, text, jsonb, bigint) FROM PUBLIC;

-- _persist_subscription gains the generation (signature change -> drop+create).
DROP FUNCTION IF EXISTS pgr._persist_subscription(text, text, text, jsonb, text);
CREATE FUNCTION pgr._persist_subscription(
    p_query_id text,
    p_query text,
    p_mode text,
    p_audience jsonb,
    p_search_path text,
    p_generation bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgr
AS $fn$
BEGIN
    INSERT INTO pgr.persisted_subscriptions
        (query_id, query_text, mode, audience, owner_role, search_path, generation, created_at, updated_at)
    VALUES
        (p_query_id, p_query, p_mode, p_audience, current_user, p_search_path, p_generation, now(), now())
    ON CONFLICT (query_id) DO UPDATE SET
        query_text  = EXCLUDED.query_text,
        mode        = EXCLUDED.mode,
        audience    = EXCLUDED.audience,
        search_path = EXCLUDED.search_path,
        generation  = EXCLUDED.generation,
        updated_at  = now();
END
$fn$;
REVOKE EXECUTE ON FUNCTION pgr._persist_subscription(text, text, text, jsonb, text, bigint) FROM PUBLIC;

-- subscription_meta now also returns the generation (RETURNS TABLE change -> drop+create).
DROP FUNCTION IF EXISTS pgr.subscription_meta(text);
CREATE FUNCTION pgr.subscription_meta(p_query_id text)
RETURNS TABLE(mode text, audience jsonb, generation bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pgr
AS $fn$
    SELECT ps.mode, ps.audience, ps.generation
    FROM pgr.persisted_subscriptions ps
    WHERE ps.query_id = p_query_id;
$fn$;
REVOKE EXECUTE ON FUNCTION pgr.subscription_meta(text) FROM PUBLIC;

-- subscribe: assign a new generation, persist it, and announce the change so the
-- proxy revokes connections from older generations immediately.
CREATE OR REPLACE FUNCTION pgr.subscribe(
    p_query_id text,
    p_query text,
    p_mode text DEFAULT 'delta',
    p_audience jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
    result jsonb;
    v_gen  bigint := nextval('pgr.subscription_generation_seq');
BEGIN
    -- Reserve the proxy's ad-hoc channel namespace: a real (catalog-backed,
    -- possibly audience-bound) subscription must not be named like an ad-hoc
    -- collaboration channel, or the proxy would treat it as public/unversioned
    -- and skip its connect-time generation re-check (round 39 batch-2 F-ADHOC).
    IF starts_with(p_query_id, '_channel_') OR starts_with(p_query_id, '_presence_') THEN
        RAISE EXCEPTION 'query_id prefix is reserved for proxy ad-hoc channels: %', p_query_id
            USING ERRCODE = 'invalid_parameter_value',
                  HINT = 'Use a name without the _channel_/_presence_ prefix; those are public ad-hoc channels.';
    END IF;
    PERFORM pgr._persist_subscription(p_query_id, p_query, p_mode, p_audience,
                                      current_setting('search_path'), v_gen);
    -- Pass the SAME generation into shmem (via the C path) that the catalog
    -- just recorded, so the connection (bound to the committed catalog gen) and
    -- the deltas (stamped with the shmem gen) agree once this commits.
    result := pgr._subscribe_internal(p_query_id, p_query, p_mode, p_audience, v_gen);
    -- Announce the new generation on the channel the proxy listens on. The
    -- proxy revokes every connection bound to a generation < v_gen. Issued
    -- AFTER the registration so it carries the committed generation, and (being
    -- queued before any later delta) is processed before deltas of this epoch.
    PERFORM pg_notify(
        COALESCE(current_setting('pg_reactive.notify_channel', true), 'pgr'),
        jsonb_build_object('type', 'resubscribed', 'query_id', p_query_id, 'gen', v_gen)::text);
    RETURN result;
END
$fn$;

-- unsubscribe: a fresh generation with no catalog row revokes every existing
-- connection (subscription_meta then returns nothing, so new connects 404).
CREATE OR REPLACE FUNCTION pgr.unsubscribe(
    p_query_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE
    result boolean;
    v_gen  bigint := nextval('pgr.subscription_generation_seq');
BEGIN
    result := pgr._unsubscribe_internal(p_query_id);
    PERFORM pgr._forget_subscription(p_query_id);
    PERFORM pg_notify(
        COALESCE(current_setting('pg_reactive.notify_channel', true), 'pgr'),
        jsonb_build_object('type', 'resubscribed', 'query_id', p_query_id, 'gen', v_gen)::text);
    RETURN result;
END
$fn$;

-- restore_subscriptions replays the durable catalog into shmem after a restart
-- wipes the hash. The catalog now carries the generation, so replay it too —
-- otherwise restored entries would emit gen=0 deltas while reconnecting clients
-- bind the catalog's real generation, and every delta would be dropped on the
-- mismatch until the next subscribe. Pinned search_path + fully-qualified refs
-- unchanged from 0.1.5 (invariant 3 / SEC-R3).
CREATE OR REPLACE FUNCTION pgr.restore_subscriptions() RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgr
AS $fn$
DECLARE
    r record;
    restored int := 0;
    failed int := 0;
BEGIN
    FOR r IN SELECT query_id, query_text, mode, audience, search_path, generation
             FROM pgr.persisted_subscriptions
             ORDER BY created_at
    LOOP
        BEGIN
            PERFORM set_config('search_path',
                               COALESCE(NULLIF(r.search_path, ''), 'pg_catalog, pgr, public'),
                               true);
            PERFORM pgr._subscribe_internal(r.query_id, r.query_text, r.mode, r.audience, r.generation);
            restored := restored + 1;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'restore subscription %: %', r.query_id, SQLERRM;
            failed := failed + 1;
        END;
    END LOOP;
    RAISE NOTICE 'pgr.restore_subscriptions: % restored, % failed', restored, failed;
    RETURN restored;
END
$fn$;
-- CREATE OR REPLACE preserves the 0.1.5 grant state, but re-assert the default
-- deny explicitly in the landing script (invariant 14 / SEC-R14): a restart-time
-- replay must never be PUBLIC-executable.
REVOKE EXECUTE ON FUNCTION pgr.restore_subscriptions() FROM PUBLIC;

COMMENT ON SEQUENCE pgr.subscription_generation_seq IS
    'Monotonic generation bumped on every subscribe/unsubscribe; bound to WS connections so a metadata change revokes older generations (round 39 batch-2).';
COMMENT ON FUNCTION pgr.subscription_meta(text) IS
    'Transactional mode/audience/generation lookup over pgr.persisted_subscriptions for the WebSocket proxy gate. MVCC, so uncommitted/rolled-back re-subscribes never leak (round 37/39).';
