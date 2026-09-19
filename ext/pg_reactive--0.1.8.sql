-- pg_reactive extension install script v0.1.8
-- GENERATED consolidated script: base 0.1.5 + upgrades 0.1.6, 0.1.7, 0.1.8
-- concatenated in chain order (exactly what CREATE EXTENSION would apply
-- via the upgrade path). Regenerate with scripts/pgxn-bundle.sh --consolidate
-- whenever a new upgrade script lands; CI installcheck proves it standalone.
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

-- ─── Security gate source for the proxy (round 37 F1) ─────────────────────
-- The WebSocket proxy enforces the audience constraint at connect time. It
-- MUST read mode/audience from this TRANSACTIONAL catalog — never from
-- pgr.get_subscriptions(), which reads the non-transactional shmem hash.
-- pgr.subscribe() mutates shmem out-of-transaction (immediately visible to
-- every backend), so a re-subscribe that flips audience inside an uncommitted
-- transaction would let a concurrent gate read see a protected subscription as
-- public — an audience bypass that persists for the whole transaction window
-- and even survives a later ROLLBACK as far as the racing reader is concerned.
-- Reading persisted_subscriptions binds the gate to the committed snapshot:
-- uncommitted re-subscribes are invisible and rolled-back ones never appear.
-- SECURITY DEFINER + pinned path so the privileged proxy role can read
-- mode/audience without a direct SELECT grant on the catalog table.
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
CREATE FUNCTION pgr.restore_subscriptions() RETURNS int -- lint:allow=SEC-R41 (transient: replaced by the INVOKER redefinition later in this same atomic script)
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
REVOKE EXECUTE ON FUNCTION pgr.subscription_meta(text)                              FROM PUBLIC;
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
    'List all active (in-shmem) subscriptions. Distinct from pgr.persisted_subscriptions which is the durable catalog. '
    'NOT a security source: shmem is non-transactional. The proxy audience gate uses pgr.subscription_meta instead.';

COMMENT ON FUNCTION pgr.subscription_meta(text) IS
    'Transactional mode/audience lookup over pgr.persisted_subscriptions for the WebSocket proxy audience gate. '
    'Reads the committed catalog (MVCC), so an uncommitted or rolled-back re-subscribe never leaks to the gate (round 37 F1).';

COMMENT ON VIEW pgr.subscriptions IS
    'Convenience view over pgr.get_subscriptions().';

COMMENT ON FUNCTION pgr.trigger_func() IS
    'Internal trigger function installed on tracked tables. Fires AFTER INSERT/UPDATE/DELETE to recompute and NOTIFY deltas.';

COMMENT ON FUNCTION pgr.stats() IS
    'Extension-wide statistics: subscribe/unsubscribe/invalidation/eviction counts and active subscription count.';

-- ═══ pg_reactive--0.1.5--0.1.6.sql ═══
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
CREATE OR REPLACE FUNCTION pgr.restore_subscriptions() RETURNS int -- lint:allow=SEC-R41 (transient: replaced by the INVOKER redefinition later in this same atomic script)
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

-- ═══ pg_reactive--0.1.6--0.1.7.sql ═══
-- pg_reactive 0.1.6 -> 0.1.7
--
-- Privilege-drop in pgr.restore_subscriptions() (gemini audit P1, CRITICAL).
--
-- restore_subscriptions runs at every postmaster restart, invoked by the boot
-- entrypoint as the superuser, and is SECURITY DEFINER (owned by the extension
-- owner — also a superuser). For each persisted subscription it re-executes the
-- stored query: pgr._subscribe_internal -> pgr_snapshot_create runs
-- `CREATE UNLOGGED TABLE pgr._snap_<id> AS <query_text>`, i.e. arbitrary SQL,
-- under the registrant's SAVED search_path. So a subscription registered with an
-- attacker-controlled search_path (pointing at the attacker's schema) and a
-- query that references an unqualified function/view resolves that reference to
-- the attacker's object and runs it AS THE SUPERUSER on the next restart —
-- privilege escalation / RCE.
--
-- Fix: drop to the owner_role that registered the subscription before replaying
-- it. This requires SET ROLE, which PostgreSQL FORBIDS inside a SECURITY DEFINER
-- function ("cannot set parameter role within security-definer function"), so
-- the function becomes SECURITY INVOKER. The boot entrypoint calls it as the
-- superuser, which is allowed to SET ROLE to any owner; RESET ROLE first so each
-- iteration starts as that superuser (a prior iteration's low-privilege owner
-- could not SET ROLE to the next one). Making it INVOKER also removes the latent
-- definer-escalation that SD itself carried: a role granted EXECUTE could
-- otherwise have run the whole restore — arbitrary stored SQL — as the superuser
-- owner. Replayed as the owner, the stored query can do no more than the owner
-- could when it first subscribed; a row with no recorded owner_role fails closed.
CREATE OR REPLACE FUNCTION pgr.restore_subscriptions() RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pgr
AS $fn$
DECLARE
    r record;
    restored int := 0;
    failed int := 0;
BEGIN
    FOR r IN SELECT query_id, query_text, mode, audience, search_path, generation, owner_role
             FROM pgr.persisted_subscriptions
             ORDER BY created_at
    LOOP
        -- No recorded owner (legacy row): refuse rather than replay arbitrary
        -- SQL as the superuser this function runs as.
        IF r.owner_role IS NULL OR r.owner_role = '' THEN
            RAISE WARNING 'restore subscription %: no owner_role recorded; refusing to replay (would run as superuser)', r.query_id;
            failed := failed + 1;
            CONTINUE;
        END IF;
        BEGIN
            -- Become the superuser definer (RESET ROLE is always allowed), then
            -- drop to the subscription's owner before re-executing its query.
            RESET ROLE;
            EXECUTE format('SET LOCAL ROLE %I', r.owner_role);
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
    RESET ROLE;
    RAISE NOTICE 'pgr.restore_subscriptions: % restored, % failed', restored, failed;
    RETURN restored;
END
$fn$;
-- CREATE OR REPLACE preserves prior grant state, but re-assert the default deny
-- in the landing script (invariant 14 / SEC-R14): a restart-time replay must
-- never be PUBLIC-executable.
REVOKE EXECUTE ON FUNCTION pgr.restore_subscriptions() FROM PUBLIC;

COMMENT ON FUNCTION pgr.restore_subscriptions() IS
    'Replays the durable subscription catalog into shmem after a restart. Drops superuser privileges to each subscription owner_role before re-executing its stored query, so a restart cannot escalate an attacker-registered subscription (gemini audit P1).';

-- ═══ pg_reactive--0.1.7--0.1.8.sql ═══
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
