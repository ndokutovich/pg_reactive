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
