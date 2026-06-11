-- pg_reactive 0.1.3 -> 0.1.4 upgrade
--
-- Adds durable subscription persistence so the in-shmem dependency hash can
-- be rebuilt after a PG restart. Re-shapes pgr.subscribe / pgr.unsubscribe
-- as plpgsql wrappers around new pgr._subscribe_internal / _unsubscribe_internal
-- C entry points; the wrappers maintain the new pgr.persisted_subscriptions
-- catalog. Adds pgr.restore_subscriptions() to replay the catalog into shmem.
--
-- Backwards compatibility: the SQL API signatures of pgr.subscribe and
-- pgr.unsubscribe are unchanged. Existing callers see no behavioural change
-- other than that their subscriptions now survive a restart (after running
-- SELECT pgr.restore_subscriptions() once on the restarted instance).
\echo Use "ALTER EXTENSION pg_reactive UPDATE" to apply this update. \quit

-- ── New C entry points (rename of the existing pgr.subscribe / unsubscribe) ──
CREATE FUNCTION pgr._subscribe_internal(
    query_id text,
    query text,
    mode text DEFAULT 'delta',
    audience jsonb DEFAULT NULL
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'pgr_subscribe'
LANGUAGE C;

CREATE FUNCTION pgr._unsubscribe_internal(
    query_id text
) RETURNS boolean
AS 'MODULE_PATHNAME', 'pgr_unsubscribe'
LANGUAGE C STRICT;

REVOKE EXECUTE ON FUNCTION pgr._subscribe_internal(text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr._unsubscribe_internal(text)                  FROM PUBLIC;

-- ── Catalog table ────────────────────────────────────────────────────────
CREATE TABLE pgr.persisted_subscriptions (
    query_id    text PRIMARY KEY,
    query_text  text NOT NULL,
    mode        text NOT NULL,
    audience    jsonb,
    owner_role  text NOT NULL DEFAULT current_user,
    -- Caller's search_path at subscribe time, replayed by
    -- restore_subscriptions() so unqualified queries re-resolve correctly.
    search_path text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- No CHECK on mode: validation lives in pgr._subscribe_internal (C).
REVOKE ALL ON pgr.persisted_subscriptions FROM PUBLIC;

-- ── Replace public subscribe / unsubscribe with persisting wrappers ──────
-- Drop the existing C-mapped functions; they're re-declared as plpgsql
-- below with the same signatures.
DROP FUNCTION pgr.subscribe(text, text, text, jsonb);
DROP FUNCTION pgr.unsubscribe(text);

-- Internal SECURITY DEFINER helpers do the catalog DML against the locked-
-- down pgr.persisted_subscriptions. Pinned search_path because they touch
-- a sensitive internal table.
CREATE FUNCTION pgr._persist_subscription(
    p_query_id text,
    p_query text,
    p_mode text,
    p_audience jsonb,
    p_search_path text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgr
AS $fn$
BEGIN
    INSERT INTO pgr.persisted_subscriptions
        (query_id, query_text, mode, audience, owner_role, search_path, created_at, updated_at)
    VALUES
        (p_query_id, p_query, p_mode, p_audience, current_user, p_search_path, now(), now())
    ON CONFLICT (query_id) DO UPDATE SET
        query_text  = EXCLUDED.query_text,
        mode        = EXCLUDED.mode,
        audience    = EXCLUDED.audience,
        search_path = EXCLUDED.search_path,
        updated_at  = now();
END
$fn$;

CREATE FUNCTION pgr._forget_subscription(
    p_query_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgr
AS $fn$
BEGIN
    DELETE FROM pgr.persisted_subscriptions WHERE query_id = p_query_id;
END
$fn$;

REVOKE EXECUTE ON FUNCTION pgr._persist_subscription(text, text, text, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr._forget_subscription(text)                           FROM PUBLIC;

-- Round 37 F1: the proxy audience gate reads mode/audience from this
-- TRANSACTIONAL catalog (MVCC), never from pgr.get_subscriptions() (shmem,
-- non-transactional). Otherwise an uncommitted/rolled-back re-subscribe leaks
-- an audience change to a concurrent gate read — an audience bypass.
CREATE FUNCTION pgr.subscription_meta(p_query_id text)
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

REVOKE EXECUTE ON FUNCTION pgr.subscription_meta(text)                              FROM PUBLIC;

-- Public subscribe / unsubscribe are SECURITY INVOKER so the caller's
-- search_path is preserved for the C extract_deps parser — otherwise
-- "SELECT * FROM my_table" would fail to resolve user tables that live
-- outside pg_catalog/pgr (a SD wrapper with a pinned safe path would
-- shadow the caller's path inside _subscribe_internal too).
CREATE FUNCTION pgr.subscribe(
    p_query_id text,
    p_query text,
    p_mode text DEFAULT 'delta',
    p_audience jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE result jsonb;
BEGIN
    -- Persist FIRST. The C call below mutates shmem out-of-transaction;
    -- a failing INSERT after a successful shmem registration would leave
    -- the shmem entry orphaned. Writing the catalog row first means a
    -- subsequent failure leaves a persisted row that pgr.restore_subscriptions
    -- can safely replay (it is idempotent on the shmem side).
    PERFORM pgr._persist_subscription(p_query_id, p_query, p_mode, p_audience,
                                      current_setting('search_path'));
    result := pgr._subscribe_internal(p_query_id, p_query, p_mode, p_audience);
    RETURN result;
END
$fn$;

CREATE FUNCTION pgr.unsubscribe(
    p_query_id text
) RETURNS boolean
LANGUAGE plpgsql
AS $fn$
DECLARE result boolean;
BEGIN
    -- Drop shmem first; if it succeeds we delete the catalog row. If the
    -- shmem drop fails, the catalog row stays — pgr.restore_subscriptions
    -- would re-register it later, leaving the user in a consistent state.
    result := pgr._unsubscribe_internal(p_query_id);
    PERFORM pgr._forget_subscription(p_query_id);
    RETURN result;
END
$fn$;

REVOKE EXECUTE ON FUNCTION pgr.subscribe(text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.unsubscribe(text)                  FROM PUBLIC;

-- ── Restore entry point ──────────────────────────────────────────────────
CREATE FUNCTION pgr.restore_subscriptions() RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgr
AS $fn$
DECLARE
    r record;
    restored int := 0;
    failed int := 0;
BEGIN
    FOR r IN SELECT query_id, query_text, mode, audience, search_path
             FROM pgr.persisted_subscriptions
             ORDER BY created_at
    LOOP
        BEGIN
            -- Replay the caller's original search_path so the C parser
            -- resolves unqualified table names. Loop query is qualified, so
            -- it is unaffected; set_config is transaction-local.
            PERFORM set_config('search_path',
                               COALESCE(NULLIF(r.search_path, ''), 'pg_catalog, pgr, public'),
                               true);
            PERFORM pgr._subscribe_internal(r.query_id, r.query_text, r.mode, r.audience);
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

REVOKE EXECUTE ON FUNCTION pgr.restore_subscriptions() FROM PUBLIC;
-- trigger_func (SECURITY DEFINER, created in the base install) was left
-- PUBLIC-executable. Triggers fire regardless of EXECUTE grant, so revoke
-- it here too — upgraded installs match the hardened fresh install.
REVOKE EXECUTE ON FUNCTION pgr.trigger_func() FROM PUBLIC;

COMMENT ON TABLE pgr.persisted_subscriptions IS
    'Durable catalog of live-query subscriptions. Survives PG restart; rebuilt into shmem by pgr.restore_subscriptions().';
COMMENT ON FUNCTION pgr.restore_subscriptions() IS
    'Rebuild the in-memory subscription hash from pgr.persisted_subscriptions. Call from a deploy post-init hook after every PG start.';
COMMENT ON FUNCTION pgr.subscribe(text, text, text, jsonb) IS
    'Register a live query. Persists to pgr.persisted_subscriptions for restart recovery.';
COMMENT ON FUNCTION pgr.unsubscribe(text) IS
    'Remove a live query subscription. Drops snapshot table, per-query triggers, and the persisted-subscriptions row.';
