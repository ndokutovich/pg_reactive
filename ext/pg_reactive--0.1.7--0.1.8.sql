-- pg_reactive 0.1.7 -> 0.1.8
--
-- Complete the restore-path privilege fix (gemini audit P1 follow-up). 0.1.7 made
-- restore_subscriptions SECURITY INVOKER and SET LOCAL ROLE owner_role before
-- replaying — but owner_role was always 'postgres', so the drop was a no-op.
--
-- The bug: pgr._persist_subscription is SECURITY DEFINER, so `current_user`
-- evaluated INSIDE it is the function's owner (the superuser that owns the
-- extension), NOT the role that called pgr.subscribe. owner_role was therefore
-- recorded as the superuser for every subscription, and restore's SET ROLE
-- dropped to the superuser — i.e. did not drop.
--
-- Fix: capture the caller's real role in pgr.subscribe (which is SECURITY
-- INVOKER, so its `current_user` IS the caller) and pass it into
-- _persist_subscription as a parameter. Now owner_role is the registrant, and
-- restore replays as them — the privilege drop is real.

-- _persist_subscription gains p_owner_role (signature change -> drop+create).
DROP FUNCTION IF EXISTS pgr._persist_subscription(text, text, text, jsonb, text, bigint);
CREATE FUNCTION pgr._persist_subscription(
    p_query_id text,
    p_query text,
    p_mode text,
    p_audience jsonb,
    p_search_path text,
    p_generation bigint,
    p_owner_role text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pgr
AS $fn$
BEGIN
    INSERT INTO pgr.persisted_subscriptions
        (query_id, query_text, mode, audience, owner_role, search_path, generation, created_at, updated_at)
    VALUES
        (p_query_id, p_query, p_mode, p_audience, p_owner_role, p_search_path, p_generation, now(), now())
    ON CONFLICT (query_id) DO UPDATE SET
        query_text  = EXCLUDED.query_text,
        mode        = EXCLUDED.mode,
        audience    = EXCLUDED.audience,
        owner_role  = EXCLUDED.owner_role,   -- last registrant owns the replay (matches the stored search_path/query)
        search_path = EXCLUDED.search_path,
        generation  = EXCLUDED.generation,
        updated_at  = now();
END
$fn$;
REVOKE EXECUTE ON FUNCTION pgr._persist_subscription(text, text, text, jsonb, text, bigint, text) FROM PUBLIC;

-- subscribe: pass the caller's real role. current_user here is the registrant
-- because pgr.subscribe is SECURITY INVOKER (it must be, so the C query parser
-- resolves the caller's search_path). Everything else unchanged from 0.1.6.
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
    IF starts_with(p_query_id, '_channel_') OR starts_with(p_query_id, '_presence_') THEN
        RAISE EXCEPTION 'query_id prefix is reserved for proxy ad-hoc channels: %', p_query_id
            USING ERRCODE = 'invalid_parameter_value',
                  HINT = 'Use a name without the _channel_/_presence_ prefix; those are public ad-hoc channels.';
    END IF;
    PERFORM pgr._persist_subscription(p_query_id, p_query, p_mode, p_audience,
                                      current_setting('search_path'), v_gen, current_user);
    result := pgr._subscribe_internal(p_query_id, p_query, p_mode, p_audience, v_gen);
    PERFORM pg_notify(
        COALESCE(current_setting('pg_reactive.notify_channel', true), 'pgr'),
        jsonb_build_object('type', 'resubscribed', 'query_id', p_query_id, 'gen', v_gen)::text);
    RETURN result;
END
$fn$;
