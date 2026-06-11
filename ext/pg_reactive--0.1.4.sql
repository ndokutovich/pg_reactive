-- pg_reactive extension install script v0.1.4
\echo Use "CREATE EXTENSION pg_reactive" to load this extension. \quit

CREATE SCHEMA IF NOT EXISTS pgr;

-- ─── C entry points (internal — see SQL wrappers below) ───────────────────
-- The C symbols are now exposed as pgr._subscribe_internal / _unsubscribe_internal
-- so the public pgr.subscribe / pgr.unsubscribe can wrap them in plpgsql to
-- also maintain the pgr.persisted_subscriptions catalog used by
-- pgr.restore_subscriptions() after a PG restart wipes the shmem hash.

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

CREATE FUNCTION pgr.get_subscriptions(
    OUT query_id text,
    OUT query_text text,
    OUT num_tables integer,
    OUT subscribed_at timestamptz,
    OUT invalidation_count bigint,
    OUT mode text,
    OUT audience jsonb
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_get_subscriptions'
LANGUAGE C STRICT;

CREATE VIEW pgr.subscriptions AS
    SELECT * FROM pgr.get_subscriptions();

-- ─── Persisted subscription catalog ───────────────────────────────────────
-- LOGGED table. Survives PG restart. Populated as a side effect of
-- pgr.subscribe / pgr.unsubscribe (see wrappers below). The shmem
-- dependency hash is rebuilt from this table by pgr.restore_subscriptions()
-- after a restart wipes shmem.
CREATE TABLE pgr.persisted_subscriptions (
    query_id    text PRIMARY KEY,
    query_text  text NOT NULL,
    mode        text NOT NULL,
    audience    jsonb,
    owner_role  text NOT NULL DEFAULT current_user,
    -- The caller's search_path at subscribe time. restore_subscriptions()
    -- replays it before re-parsing query_text, so an unqualified query like
    -- "SELECT id FROM orders" (orders in public) resolves on restart exactly
    -- as it did at subscribe time. Without this, restore ran under the
    -- function's pinned pg_catalog,pgr path and failed to extract any table
    -- references for non-fully-qualified queries.
    search_path text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- NB: no CHECK on mode here. Validation lives in pgr._subscribe_internal
-- (C) — replicating it as a table CHECK would create two sources of
-- truth, and because the wrapper writes the catalog row BEFORE calling
-- the C path (for atomic rollback semantics), a stricter CHECK would
-- raise with a different message and intercept errors the C-side test
-- harness asserts on.

REVOKE ALL ON pgr.persisted_subscriptions FROM PUBLIC;

-- ─── Internal catalog DML helpers (SECURITY DEFINER, locked to pgr) ──────
-- pgr.subscribe / pgr.unsubscribe stay SECURITY INVOKER so the C parser
-- in _subscribe_internal still sees the caller's search_path (otherwise a
-- user query like "SELECT * FROM my_table" can't resolve tables in
-- schemas outside pg_catalog/pgr). The catalog writes are routed through
-- these tiny SD helpers that DO have a pinned safe path.
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

-- ─── Public subscribe / unsubscribe wrappers (SECURITY INVOKER) ──────────
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
    -- We capture the caller's current search_path so restore can re-resolve
    -- unqualified table names exactly as they resolved here (this wrapper is
    -- INVOKER, so current_setting sees the caller's session path).
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
    result := pgr._unsubscribe_internal(p_query_id);
    PERFORM pgr._forget_subscription(p_query_id);
    RETURN result;
END
$fn$;

-- ─── Restore-after-restart entry point ────────────────────────────────────
-- Idempotent. Returns count of successfully restored subscriptions.
-- Reports per-query failures via RAISE WARNING so partial failures don't
-- abort the entire restore (e.g. one query references a dropped table).
--
-- Should be called from a deployment post-init hook (post-init.sh,
-- docker-entrypoint, k8s initContainer) immediately after PG accepts
-- connections, so the time window where DML fires triggers that look up
-- empty shmem is minimal.
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
            -- resolves unqualified table names. The loop query above is
            -- fully qualified, so it is unaffected by this change;
            -- set_config(..., true) is transaction-local and the function's
            -- pinned SET search_path is restored on exit.
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

-- ─── Internal trigger function (unchanged from 0.1.3) ─────────────────────
CREATE FUNCTION pgr.trigger_func()
RETURNS trigger
AS 'MODULE_PATHNAME', 'pgr_trigger_func'
LANGUAGE C
SECURITY DEFINER
SET search_path = pgr, pg_catalog, public;

CREATE FUNCTION pgr.stats(
    OUT metric text,
    OUT value text
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_stats'
LANGUAGE C STRICT;

GRANT USAGE ON SCHEMA pgr TO PUBLIC;

-- Default-deny posture. pgr.subscribe / unsubscribe are SECURITY INVOKER
-- (so the C parser sees the caller's search_path), and they PERFORM the
-- revoked pgr._subscribe_internal in the caller's privilege context — so a
-- plain `GRANT EXECUTE ON pgr.subscribe TO approle` is NOT sufficient and
-- yields "permission denied for function _subscribe_internal". This is
-- intentional: pgr.subscribe stores raw SQL re-executed by SECURITY DEFINER
-- triggers and is a privileged API (docs/specs §9.4, CLAUDE.md). Expose
-- subscription registration to app roles only through a purpose-built
-- SECURITY DEFINER wrapper with a fixed query template and server-derived
-- query_id/audience — never by granting the raw functions. The
-- _persist_subscription / _forget_subscription helpers are SECURITY DEFINER
-- and MUST be revoked too: PostgreSQL grants PUBLIC EXECUTE on new functions
-- by default, so without this any role could write arbitrary rows into the
-- durable catalog, which restore_subscriptions replays as the extension
-- owner (persistence poisoning).
REVOKE EXECUTE ON FUNCTION pgr._subscribe_internal(text, text, text, jsonb)         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr._unsubscribe_internal(text)                          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr._persist_subscription(text, text, text, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr._forget_subscription(text)                           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.subscribe(text, text, text, jsonb)                   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.unsubscribe(text)                                    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.get_subscriptions()                                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.stats()                                              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.restore_subscriptions()                              FROM PUBLIC;
-- trigger_func is SECURITY DEFINER. PostgreSQL does not require EXECUTE on a
-- trigger function for the triggering DML, so revoking it from PUBLIC keeps
-- triggers firing while closing direct user calls.
REVOKE EXECUTE ON FUNCTION pgr.trigger_func()                                       FROM PUBLIC;
REVOKE SELECT  ON pgr.subscriptions                                                 FROM PUBLIC;

COMMENT ON FUNCTION pgr.subscribe(text, text, text, jsonb) IS
    'Register a live query. Persists to pgr.persisted_subscriptions for restart recovery. '
    'Mode: delta (default) = full diff with snapshots, notify = lightweight invalidation. '
    'audience: NULL = public, JSON object = proxy enforces every key matches the corresponding JWT claim at WS-connect.';

COMMENT ON FUNCTION pgr.unsubscribe(text) IS
    'Remove a live query subscription. Drops snapshot table, per-query triggers, and the persisted-subscriptions row.';

COMMENT ON FUNCTION pgr.restore_subscriptions() IS
    'Rebuild the in-memory subscription hash from pgr.persisted_subscriptions. '
    'Call from a deploy post-init hook after every PG start. Returns the number of successfully restored subscriptions.';

COMMENT ON TABLE pgr.persisted_subscriptions IS
    'Durable catalog of live-query subscriptions. Survives PG restart; rebuilt into shmem by pgr.restore_subscriptions().';

COMMENT ON FUNCTION pgr.get_subscriptions() IS
    'List all active (in-shmem) subscriptions. Distinct from pgr.persisted_subscriptions which is the durable catalog.';

COMMENT ON VIEW pgr.subscriptions IS
    'Convenience view over pgr.get_subscriptions().';

COMMENT ON FUNCTION pgr.trigger_func() IS
    'Internal trigger function installed on tracked tables. Fires AFTER INSERT/UPDATE/DELETE to recompute and NOTIFY deltas.';

COMMENT ON FUNCTION pgr.stats() IS
    'Extension-wide statistics: subscribe/unsubscribe/invalidation/eviction counts and active subscription count.';
