-- Migration: demo_tables_rls
-- Created at: 2026-06-20T12:00:00.000Z
--
-- Makes the shipped demo schema production-ready on EXISTING installs.
-- SECURITY.md invariant #26 / SEC-R44.
--
-- The demo tables `todos`, `authors`, `posts`, `comments` historically granted
-- full SELECT/INSERT/UPDATE/DELETE to `anon` with NO row-level security, so any
-- unauthenticated visitor could read, overwrite, and DELETE every row (and the
-- demo modelled the anti-pattern). `docker/init.sql` now ships them hardened;
-- the earlier `20260515200000_revoke_blanket_grants` migration RE-granted the
-- old anon CRUD on existing installs, so this migration supersedes that for the
-- four main demo tables:
--
--   * todos  -> per-user RLS (owner-scoped policies, authenticated-only; anon
--               loses all access; user_id defaults to auth.uid()).
--   * blog   -> public-READ (anon + authenticated SELECT) with writes locked to
--               service_role (anon/authenticated lose INSERT/UPDATE/DELETE).
--
-- Idempotent: each table is only touched when it exists. user_id is left
-- nullable on existing installs (pre-existing NULL rows would block SET NOT
-- NULL; RLS already hides them since user_id = auth.uid() never matches NULL) —
-- fresh installs get NOT NULL from init.sql.

-- migrate:up

DO $$
BEGIN
  -- ── todos: per-user RLS ────────────────────────────────────────────────────
  IF to_regclass('public.todos') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.todos ALTER COLUMN user_id SET DEFAULT auth.uid()';
    EXECUTE 'ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_select ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_insert ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_update ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_delete ON public.todos';
    EXECUTE 'CREATE POLICY todos_own_select ON public.todos FOR SELECT TO authenticated USING (user_id = auth.uid())';
    EXECUTE 'CREATE POLICY todos_own_insert ON public.todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())';
    EXECUTE 'CREATE POLICY todos_own_update ON public.todos FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';
    EXECUTE 'CREATE POLICY todos_own_delete ON public.todos FOR DELETE TO authenticated USING (user_id = auth.uid())';
    -- anon loses everything; authenticated keeps RLS-scoped DML.
    EXECUTE 'REVOKE ALL ON public.todos FROM anon';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.todos_id_seq FROM anon';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO authenticated';
  END IF;

  -- ── blog: public-read, service_role-only writes ────────────────────────────
  IF to_regclass('public.authors') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS authors_public_read ON public.authors';
    EXECUTE 'CREATE POLICY authors_public_read ON public.authors FOR SELECT TO anon, authenticated USING (true)';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.authors FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.authors_id_seq FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.authors TO anon, authenticated';
  END IF;
  IF to_regclass('public.posts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS posts_public_read ON public.posts';
    EXECUTE 'CREATE POLICY posts_public_read ON public.posts FOR SELECT TO anon, authenticated USING (true)';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.posts FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.posts_id_seq FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.posts TO anon, authenticated';
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS comments_public_read ON public.comments';
    EXECUTE 'CREATE POLICY comments_public_read ON public.comments FOR SELECT TO anon, authenticated USING (true)';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.comments FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE public.comments_id_seq FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.comments TO anon, authenticated';
  END IF;
END $$;

-- migrate:down

-- Down restores the prior (insecure) wide-open grants — intentionally unsafe,
-- provided only for rollback symmetry. Re-running the forward migration (or a
-- fresh init.sql) re-hardens.
DO $$
BEGIN
  IF to_regclass('public.todos') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS todos_own_select ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_insert ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_update ON public.todos';
    EXECUTE 'DROP POLICY IF EXISTS todos_own_delete ON public.todos';
    EXECUTE 'ALTER TABLE public.todos DISABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO anon, authenticated';
  END IF;
  IF to_regclass('public.authors') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS authors_public_read ON public.authors';
    EXECUTE 'ALTER TABLE public.authors DISABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.authors TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.authors_id_seq TO anon, authenticated';
  END IF;
  IF to_regclass('public.posts') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS posts_public_read ON public.posts';
    EXECUTE 'ALTER TABLE public.posts DISABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.posts_id_seq TO anon, authenticated';
  END IF;
  IF to_regclass('public.comments') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS comments_public_read ON public.comments';
    EXECUTE 'ALTER TABLE public.comments DISABLE ROW LEVEL SECURITY';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.comments TO anon, authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.comments_id_seq TO anon, authenticated';
  END IF;
END $$;
