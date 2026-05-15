-- Migration: revoke_blanket_grants
-- Created at: 2026-05-15T20:00:00.000Z
--
-- Closes audit finding F3 on existing installs.
--
-- Before this migration, fresh pgStack databases granted `SELECT ON ALL TABLES
-- IN SCHEMA public TO anon` and `ALL ON ALL TABLES IN SCHEMA public TO
-- authenticated`, plus `ALTER DEFAULT PRIVILEGES` so any future CREATE TABLE
-- in `public` inherited the same blanket access. That made any new application
-- table silently readable through REST until RLS was added — a footgun that
-- contradicts secure-by-default.
--
-- This migration:
--   1. Drops the ALTER DEFAULT PRIVILEGES rules so future tables are NOT
--      auto-granted.
--   2. Revokes the blanket ALL/SELECT grants on EXISTING tables in public
--      from anon and authenticated.
--   3. Re-grants the per-table privileges needed by the shipped demo /
--      e2e-test fixtures (idempotent: only fires when the table exists).
--
-- After running this migration, application tables in `public` must include
-- explicit GRANT statements in their own migrations (and should enable RLS).
-- service_role is unchanged — it keeps blanket access for proxy internals.

-- migrate:up

-- 1. Drop the future-table auto-grants for anon/authenticated.
DO $$
DECLARE
  -- The docker/init.sql owner used to be `postgres`. ALTER DEFAULT PRIVILEGES
  -- is scoped to the role that CREATEd the rule, so revoke from each plausible
  -- owner. Failures are swallowed because the rule may simply not exist.
  owners text[] := ARRAY['postgres', current_user];
  o text;
BEGIN
  FOREACH o IN ARRAY owners LOOP
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated', o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT ON TABLES FROM anon', o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM anon, authenticated', o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;

-- 2. Revoke blanket grants on existing tables in `public` from anon + authenticated.
--    service_role keeps its ALL access.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 3. Re-grant per-table privileges for the demo / test fixtures shipped with
--    pgStack. Each block is no-op when the table is absent.
DO $$
BEGIN
  -- todos (e2e_rest_test fixture)
  IF to_regclass('public.todos') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO anon, authenticated';
  END IF;
  -- blog: authors, posts, comments (e2e_embed_test fixture)
  IF to_regclass('public.authors')  IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON authors  TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE authors_id_seq  TO anon, authenticated';
  END IF;
  IF to_regclass('public.posts')    IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON posts    TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE posts_id_seq    TO anon, authenticated';
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON comments TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE comments_id_seq TO anon, authenticated';
  END IF;
  -- Example fixtures: only present when the examples stack has run.
  IF to_regclass('public.products')          IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON products          TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE products_id_seq          TO anon, authenticated';
  END IF;
  IF to_regclass('public.customers')         IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON customers         TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE customers_id_seq         TO anon, authenticated';
  END IF;
  IF to_regclass('public.orders')            IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON orders            TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE orders_id_seq            TO anon, authenticated';
  END IF;
  IF to_regclass('public.inventory')         IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON inventory         TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE inventory_id_seq         TO anon, authenticated';
  END IF;
  IF to_regclass('public.sensor_readings')   IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON sensor_readings   TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE sensor_readings_id_seq   TO anon, authenticated';
  END IF;
  IF to_regclass('public.tut_products')      IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tut_products      TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tut_products_id_seq      TO anon, authenticated';
  END IF;
  IF to_regclass('public.tut_customers')     IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tut_customers     TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tut_customers_id_seq     TO anon, authenticated';
  END IF;
  IF to_regclass('public.tut_orders')        IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tut_orders        TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tut_orders_id_seq        TO anon, authenticated';
  END IF;
END $$;

-- migrate:down

-- Restore the old (footgun) blanket grants. This is provided for emergency
-- rollback only; running this in production reintroduces F3.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL    ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL    ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
