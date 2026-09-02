-- Migration: anonymous_role
-- Created at: 2026-09-02T12:00:00.000Z
-- Revised 2026-09-03: every statement is guarded. The first cut left an
-- UNGUARDED `GRANT anonymous TO authenticator` after the guarded CREATE ROLE:
-- on a database without the authenticator login role (standalone pg_reactive,
-- pre-two-pool installs) psql -v ON_ERROR_STOP=1 aborted EXACTLY there —
-- role created, zero grants applied, everything below skipped (found by the
-- umbrella VPS deployment: 3 of 7 containers). A migration that can stop
-- halfway must be composed of steps that each tolerate the worlds they run
-- in; anything referencing an object that may not exist checks first.
--
-- pgStack 0.3.0: guests from /auth/v1/anonymous become a first-class
-- principal. A guest signs in as PG role `anonymous` (strict default;
-- ANONYMOUS_ROLE=authenticated restores the Supabase-compatible flat model),
-- with a real row in pgstack.users and `is_anonymous: true` in the JWT.
--
-- Trust ordering (SECURITY.md INV-A):
--   anon  ⊆  anonymous  ⊂  authenticated  <  service_role
--
-- Every grant `TO anon` is mirrored to `anonymous` here; grants and policies
-- `TO authenticated` are NOT — a guest reaches member-only capabilities only
-- when a policy site names `anonymous` explicitly. After running this,
-- audit YOUR application policies: for each `TO authenticated` policy where
-- guests belong, change to `TO authenticated, anonymous`. Everything keyed on
-- auth.uid() keeps working unchanged — guest ids are stable and survive the
-- upgrade-to-email flow.
--
-- Idempotent AND partial-state-safe: safe to re-run on a fresh, a migrated,
-- a half-migrated, or a bare (no pgStack core) database.

-- migrate:up

-- 1. The role itself + login-role memberships. Membership grants are guarded:
--    the grantee may not exist (standalone pg_reactive has no authenticator;
--    a managed cluster may name its superuser differently).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anonymous') THEN
    CREATE ROLE anonymous NOLOGIN;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT anonymous TO postgres;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    GRANT anonymous TO authenticator;
  END IF;
END $$;

-- 2. INV-A: mirror the anon baseline. Schemas/tables exist only on a pgStack
--    core database — each grant checks its object first.
DO $$ BEGIN
  IF to_regnamespace('pgstack') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA pgstack TO anonymous;
  END IF;
  IF to_regnamespace('auth') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA auth TO anonymous;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anonymous;
  END IF;
  GRANT USAGE ON SCHEMA public TO anonymous;
  IF to_regclass('pgstack.storage_buckets') IS NOT NULL THEN
    GRANT SELECT ON pgstack.storage_buckets TO anonymous;
  END IF;
  IF to_regclass('pgstack.storage_objects') IS NOT NULL THEN
    GRANT SELECT ON pgstack.storage_objects TO anonymous;
  END IF;
END $$;

-- 3. Own-identity: a guest that cannot read its own row is not an account.
DO $$ BEGIN
  IF to_regclass('pgstack.users') IS NOT NULL THEN
    GRANT SELECT ON pgstack.users TO anonymous;
  END IF;
  IF EXISTS (SELECT FROM pg_policies WHERE schemaname = 'pgstack'
             AND tablename = 'users' AND policyname = 'users_self_select') THEN
    ALTER POLICY users_self_select ON pgstack.users TO authenticated, anonymous;
  END IF;
  IF EXISTS (SELECT FROM pg_policies WHERE schemaname = 'pgstack'
             AND tablename = 'storage_buckets' AND policyname = 'storage_buckets_select') THEN
    ALTER POLICY storage_buckets_select ON pgstack.storage_buckets
      TO anon, authenticated, anonymous;
  END IF;
  IF EXISTS (SELECT FROM pg_policies WHERE schemaname = 'pgstack'
             AND tablename = 'storage_objects' AND policyname = 'storage_objects_public_select') THEN
    ALTER POLICY storage_objects_public_select ON pgstack.storage_objects
      TO anon, authenticated, anonymous;
  END IF;
END $$;

-- 4. Shipped demo fixtures (only when present; your own tables are YOUR audit).
DO $$ BEGIN
  IF to_regclass('public.todos') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO anonymous;
    IF to_regclass('public.todos_id_seq') IS NOT NULL THEN
      GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO anonymous;
    END IF;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='todos' AND policyname='todos_own_select') THEN
      ALTER POLICY todos_own_select ON public.todos TO authenticated, anonymous;
    END IF;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='todos' AND policyname='todos_own_insert') THEN
      ALTER POLICY todos_own_insert ON public.todos TO authenticated, anonymous;
    END IF;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='todos' AND policyname='todos_own_update') THEN
      ALTER POLICY todos_own_update ON public.todos TO authenticated, anonymous;
    END IF;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='todos' AND policyname='todos_own_delete') THEN
      ALTER POLICY todos_own_delete ON public.todos TO authenticated, anonymous;
    END IF;
  END IF;
END $$;

-- 5. Shipped blog demo fixtures + demo RPC functions (INV-A mirrors; only
--    when present).
DO $$ BEGIN
  IF to_regclass('public.authors') IS NOT NULL THEN
    GRANT SELECT ON public.authors TO anonymous;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='authors' AND policyname='authors_public_read') THEN
      ALTER POLICY authors_public_read ON public.authors TO anon, authenticated, anonymous;
    END IF;
  END IF;
  IF to_regclass('public.posts') IS NOT NULL THEN
    GRANT SELECT ON public.posts TO anonymous;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='posts' AND policyname='posts_public_read') THEN
      ALTER POLICY posts_public_read ON public.posts TO anon, authenticated, anonymous;
    END IF;
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    GRANT SELECT ON public.comments TO anonymous;
    IF EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='comments' AND policyname='comments_public_read') THEN
      ALTER POLICY comments_public_read ON public.comments TO anon, authenticated, anonymous;
    END IF;
  END IF;
  IF to_regprocedure('public.add_numbers(integer, integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.add_numbers(integer, integer) TO anonymous;
  END IF;
  IF to_regprocedure('public.get_greeting(text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.get_greeting(text) TO anonymous;
  END IF;
  IF to_regprocedure('public.list_active_authors()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.list_active_authors() TO anonymous;
  END IF;
  IF to_regprocedure('public.get_post_stats()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.get_post_stats() TO anonymous;
  END IF;
END $$;

-- migrate:down
-- Deliberately empty: dropping a role that live JWTs still name would strand
-- sessions mid-flight. Roll back by redeploying a pre-0.3.0 proxy (it never
-- issues role=anonymous); the extra role is inert.
