-- Migration: admin_login_role
-- Created at: 2026-06-13T14:00:00.000Z
--
-- gemini audit finding 6 on existing installs: split the single proxy login
-- role into a data role (anon/authenticated) and a separate admin role
-- (service_role), so a data-plane compromise cannot RESET ROLE + SET ROLE
-- service_role to reach BYPASSRLS / app-admin.
--
-- This migration is SAFE and NON-breaking on its own: it creates
-- `authenticator_admin` and grants it service_role, but leaves `authenticator`
-- a member of service_role so the proxy's existing admin pool (DATABASE_URL +
-- SET ROLE service_role) keeps working. Completing the split is an OPERATIONAL
-- cutover (cannot live in a migration):
--
--   1. Give authenticator_admin a login password (= AUTHENTICATOR_ADMIN_PASSWORD):
--        ALTER ROLE authenticator_admin LOGIN PASSWORD '<strong-random>';
--   2. Point the proxy's admin pool at it:
--        ADMIN_DATABASE_URL=postgres://authenticator_admin:<pw>@db:5432/<db>
--      and restart the proxy. The data pool keeps DATABASE_URL=authenticator.
--   3. ONLY THEN remove the data role's escalation path:
--        REVOKE service_role FROM authenticator;
--      Doing step 3 before step 2 breaks the admin pool. See SECURITY.md inv 24.

-- migrate:up
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator_admin') THEN
    CREATE ROLE authenticator_admin NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT service_role TO authenticator_admin;

-- migrate:down
--
-- Reverting drops the dedicated admin role and forces the proxy back onto the
-- single-role model where the data plane can escalate to service_role
-- (finding 6). Reverse manually only after repointing ADMIN_DATABASE_URL back
-- to the data role and re-granting service_role to authenticator.
DO $$ BEGIN
    RAISE EXCEPTION
        'Refusing to roll back 20260613140000_admin_login_role — dropping the '
        'admin login role re-merges the data and admin planes (finding 6: a '
        'data-plane compromise could then SET ROLE service_role). Reverse '
        'manually after repointing the proxy off authenticator_admin.';
END $$;
