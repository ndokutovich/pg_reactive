-- Audit round 28 F1 (HIGH) + round 29 F1 (Medium):
--
-- Revoke the PostgreSQL default of PUBLIC EXECUTE on every function in
-- `public`, plus the default-privileges entries that re-grant it on
-- every CREATE FUNCTION.
--
-- The REST endpoint at /rest/v1/rpc/{fn} walks pg_proc and exposes any
-- function in `public`. PostgreSQL grants EXECUTE to PUBLIC by default,
-- which means anon and authenticated automatically inherit the right
-- to call any newly-created function — including SECURITY DEFINER
-- helpers that were meant for trigger / definer-context paths only.
--
-- Round-29 fix: ALTER DEFAULT PRIVILEGES is scoped to the ROLE that
-- CREATEd the rule. A bare ALTER DEFAULT PRIVILEGES only covers the
-- migration user. If the docker/init.sql owner was `postgres` or any
-- multi-tenant setup creates functions under a different role, those
-- owners would still grant PUBLIC EXECUTE on every CREATE FUNCTION.
-- Same shape as the round-12 table-grants migration: loop over the
-- plausible owners (postgres + current_user) and revoke for each.

-- migrate:up

-- 1. Strip PUBLIC EXECUTE from every function currently in `public`.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- 2. Future functions: revoke PUBLIC EXECUTE from every owner that
--    might legitimately create functions in `public`. Failures
--    swallowed because the rule may simply not exist for a given owner.
DO $$
DECLARE
  owners text[] := ARRAY['postgres', current_user];
  o text;
BEGIN
  FOREACH o IN ARRAY owners LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
        o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;

-- 3. Restore blanket EXECUTE for service_role (admin role; bypasses
--    RLS too) so internal maintenance / catalog refresh / migrations
--    keep working unchanged. Cover both currently-existing functions
--    and the future-functions default for every plausible owner.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
DO $$
DECLARE
  owners text[] := ARRAY['postgres', current_user];
  o text;
BEGIN
  FOREACH o IN ARRAY owners LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role',
        o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;

-- After applying, any function you want callable via /rest/v1/rpc must
-- carry an explicit GRANT EXECUTE ... TO authenticated (or whichever
-- role you intend). The bootstrap docstring shows the pattern.

-- migrate:down
--
-- Reintroduces the default-grants footgun if rolled back. Hard-abort
-- with a pointer to the explicit unsafe-rollback script, mirroring
-- how 20260515200000 handles its own dangerous reverse.
DO $$ BEGIN
    RAISE EXCEPTION
        'Refusing to roll back 20260519120000_revoke_public_function_execute — '
        'restoring PUBLIC EXECUTE on functions would re-introduce audit F1 '
        '(any public.* function becomes anonymously/authenticated-callable '
        'via /rest/v1/rpc, including SECURITY DEFINER helpers meant for '
        'trigger-only use). If you truly need the rollback, apply '
        'migrations/unsafe-rollback/20260519120000_restore_public_function_execute.sql '
        'manually and accept that every subsequent CREATE FUNCTION will '
        'inherit the unsafe PUBLIC EXECUTE default.';
END $$;
