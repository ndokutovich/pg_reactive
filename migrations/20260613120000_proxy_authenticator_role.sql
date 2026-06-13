-- Migration: proxy_authenticator_role
-- Created at: 2026-06-13T12:00:00.000Z
--
-- Closes gemini audit P2 on existing installs: the proxy must connect to
-- PostgreSQL as a NON-superuser.
--
-- Fresh pgStack databases get the `authenticator` role + the service_role DML
-- grants from docker/init.sql CORE. Databases created before this change have
-- no `authenticator` role and a `service_role` missing the storage/auth DML and
-- CREATE-on-public that the proxy now needs once it stops connecting as the
-- superuser. This migration brings an existing database up to that model so the
-- operator can switch the proxy's DATABASE_URL to `authenticator`.
--
-- This migration is idempotent and does NOT, by itself, change how the proxy
-- connects. AFTER running it, two OPERATIONAL steps remain (they cannot live in
-- a migration):
--   1. Give `authenticator` a login password:
--        ALTER ROLE authenticator LOGIN PASSWORD '<strong-random>';
--   2. Repoint the proxy: DATABASE_URL=postgres://authenticator:<pw>@db:5432/<db>
-- See SECURITY.md invariant 22.

-- migrate:up

-- 1. The powerless `authenticator` role — NOSUPERUSER, NOINHERIT (holds none of
--    its member roles' privileges until it SET ROLEs). Created NOLOGIN: the
--    operator grants LOGIN + a password out of band (step 1 above).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- authenticator may ASSUME (SET ROLE) the request roles for the RLS-bound data
-- plane and service_role for the trusted admin plane. Idempotent.
GRANT anon, authenticated, service_role TO authenticator;

-- 2. service_role grants that were implicit under a superuser connection. The
--    admin pool assumes service_role; it needs explicit DML on the auth +
--    storage tables, CREATE on public (for /api/sql DDL + CLI migrations), and
--    the sequences. Guarded so the migration is safe on a partial schema.
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables
             WHERE table_schema = 'pgstack' AND table_name = 'users') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      pgstack.users, pgstack.refresh_tokens, pgstack.oauth_sessions, pgstack.email_tokens
      TO service_role;
  END IF;
  IF EXISTS (SELECT FROM information_schema.tables
             WHERE table_schema = 'pgstack' AND table_name = 'storage_objects') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      pgstack.storage_buckets, pgstack.storage_objects
      TO service_role;
  END IF;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgstack') THEN
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgstack TO service_role';
  END IF;
END $$;

GRANT CREATE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- 3. DDL event trigger: grant service_role access to the pg_reactive runtime
--    objects (subscription_meta + per-query _snap_* snapshot tables created by
--    pgr.subscribe as CREATE TABLE AS) so the realtime gate — which runs on the
--    admin/service_role pool — can read them. No-op when service_role or the pgr
--    schema is absent, so pg_reactive stays usable standalone.
CREATE OR REPLACE FUNCTION pgstack.grant_pgr_access_to_service_role()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    obj record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgr') THEN RETURN; END IF;
    FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        BEGIN
            IF obj.command_tag IN ('CREATE EXTENSION', 'ALTER EXTENSION') THEN
                EXECUTE 'GRANT USAGE ON SCHEMA pgr TO service_role';
                IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'pgr' AND p.proname = 'subscription_meta') THEN
                    EXECUTE 'GRANT EXECUTE ON FUNCTION pgr.subscription_meta(text) TO service_role';
                END IF;
                EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA pgr TO service_role';
            ELSIF obj.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS') AND obj.schema_name = 'pgr' THEN
                EXECUTE format('GRANT SELECT ON %s TO service_role', obj.object_identity);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS pgstack_grant_pgr_to_service;
CREATE EVENT TRIGGER pgstack_grant_pgr_to_service
    ON ddl_command_end
    WHEN TAG IN ('CREATE EXTENSION', 'ALTER EXTENSION', 'CREATE TABLE', 'CREATE TABLE AS')
    EXECUTE FUNCTION pgstack.grant_pgr_access_to_service_role();

-- One-shot catch-up: if pg_reactive is already installed, grant the runtime
-- objects now (the event trigger only fires on FUTURE DDL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgr') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA pgr TO service_role';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA pgr TO service_role';
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'pgr' AND p.proname = 'subscription_meta') THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION pgr.subscription_meta(text) TO service_role';
    END IF;
  END IF;
END $$;

-- migrate:down
--
-- Refusing to roll back: dropping `authenticator` breaks any proxy already
-- repointed to it, and revoking service_role's grants breaks the admin pool —
-- forcing a fall-back to a superuser connection, which is exactly the audit-P2
-- hole this migration closes. There is no safe automatic reverse. If you must,
-- manually ALTER the proxy DSN back to the superuser first, then DROP ROLE
-- authenticator and REVOKE the grants by hand, accepting the RLS-bypass /
-- COPY-FROM-PROGRAM exposure that re-introduces.
DO $$ BEGIN
    RAISE EXCEPTION
        'Refusing to roll back 20260613120000_proxy_authenticator_role — '
        'dropping the authenticator role / service_role grants forces the proxy '
        'back onto a superuser connection (RLS bypass, COPY ... FROM PROGRAM, '
        'pg_authid access — SECURITY.md invariant 22). Reverse manually only '
        'after repointing DATABASE_URL away from authenticator.';
END $$;
