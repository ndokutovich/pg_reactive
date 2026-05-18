-- Audit round 28 F1 (HIGH): revoke the PostgreSQL default of PUBLIC
-- EXECUTE on every function in `public`, plus the default-privileges
-- entry that re-grants it on every CREATE FUNCTION.
--
-- The REST endpoint at /rest/v1/rpc/{fn} walks pg_proc and exposes any
-- function in `public`. PostgreSQL grants EXECUTE to PUBLIC by default,
-- which means anon and authenticated automatically inherit the right
-- to call any newly-created function — including SECURITY DEFINER
-- helpers that were meant for trigger / definer-context paths only.
--
-- This migration:
--   1. Strips the existing PUBLIC EXECUTE on every function currently
--      in `public`.
--   2. Flips the default-privileges so future CREATE FUNCTION lands
--      with no PUBLIC EXECUTE.
--   3. Restores blanket EXECUTE for service_role (admin role; bypasses
--      RLS too) so internal maintenance / catalog refresh / migrations
--      keep working unchanged.
--
-- After applying, any function you want callable via /rest/v1/rpc must
-- carry an explicit GRANT EXECUTE ... TO authenticated (or whichever
-- role you intend). The bootstrap docstring shows the pattern.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
