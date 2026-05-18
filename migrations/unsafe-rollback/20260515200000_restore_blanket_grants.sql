-- ⚠️  UNSAFE EMERGENCY ROLLBACK — DO NOT RUN UNDER NORMAL CIRCUMSTANCES.
--
-- This script restores the blanket public-schema GRANTs that
-- migrations/20260515200000_revoke_blanket_grants.sql removed. It exists
-- ONLY for the rare case where an operator must temporarily reopen the
-- old permission model to recover from a botched application change and
-- has no other path.
--
-- Running this re-introduces audit F3 (round 12):
--   • Any role with authenticated grants can read/write every public
--     table, regardless of RLS policies.
--   • ALTER DEFAULT PRIVILEGES makes EVERY future CREATE TABLE inherit
--     these unsafe defaults — even tables you forget to RLS-enable
--     will be world-writable from the proxy.
--
-- After applying, immediately re-apply
-- migrations/20260515200000_revoke_blanket_grants.sql plus any
-- per-table grants your application actually needs.
--
-- The default migrate:down path for the original migration aborts with
-- a RAISE EXCEPTION pointing here, so an operator never invokes this by
-- accident.

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL    ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL    ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
