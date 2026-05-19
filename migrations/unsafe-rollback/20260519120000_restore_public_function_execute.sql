-- ⚠️  UNSAFE EMERGENCY ROLLBACK — DO NOT RUN UNDER NORMAL CIRCUMSTANCES.
--
-- This script restores the PostgreSQL default of PUBLIC EXECUTE on
-- functions in `public` that migration
-- 20260519120000_revoke_public_function_execute.sql removed. It exists
-- only for the rare case where an operator must temporarily reopen the
-- old permission model to recover from a botched application change.
--
-- Running this re-introduces audit round-28 F1 (HIGH):
--   • Every public.* function — including SECURITY DEFINER helpers
--     intended for trigger / internal use — becomes callable via the
--     /rest/v1/rpc/{fn} endpoint by anon and authenticated.
--   • ALTER DEFAULT PRIVILEGES makes EVERY future CREATE FUNCTION
--     inherit the unsafe default for every listed owner.
--
-- After applying, immediately re-apply the proper migration and
-- per-function GRANTs your app actually needs.
--
-- The default migrate:down path for the original migration aborts
-- with a RAISE EXCEPTION pointing here, so an operator never invokes
-- this by accident.

-- The two GRANT lines below are exactly what makes this script
-- "unsafe-rollback". The lint:allow markers acknowledge the rule —
-- this file is the manually-invoked recovery hatch the default
-- migrate:down points to; it is never run automatically.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;  -- lint:allow=SEC-R28
DO $$
DECLARE
  owners text[] := ARRAY['postgres', current_user];
  o text;
BEGIN
  FOREACH o IN ARRAY owners LOOP
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC',  -- lint:allow=SEC-R28
        o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;
