-- ───────────────────────────────────────────────────────────────────────────
-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Source of truth: docker/init.sql, region between
--   -- BEGIN-PGSTACK-CORE / -- END-PGSTACK-CORE
-- Sync:           node scripts/sync-cli-bootstrap.mjs
-- CI parity:      .github/workflows/ci.yml "cli/templates/bootstrap-core.sql parity"
--
-- This file is the security-critical bootstrap backbone the CLI
-- emits when a user runs `pgstack init`. It contains roles, schemas,
-- auth tables, RLS, and the default-deny grants for `public`. Demo
-- tables and dev fixtures stay in docker/init.sql and do NOT ship
-- in the CLI bootstrap — those are the operator's job to add via
-- their own migrations.
-- ───────────────────────────────────────────────────────────────────────────

-- Roles
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  -- TWO proxy login roles, split so the data plane cannot escalate to the admin
  -- plane (gemini audit finding 6). Both are NON-superuser, cannot create
  -- roles/databases, and NOINHERIT — they hold NONE of their member roles'
  -- privileges until they explicitly SET ROLE. This replaces connecting as the
  -- superuser (P2: RLS bypass, COPY ... FROM PROGRAM, DROP DATABASE, pg_authid).
  --
  --   authenticator        — the REQUEST-facing data plane. Member of anon +
  --                          authenticated ONLY, so a SQL injection here can
  --                          RESET ROLE back to authenticator but STILL cannot
  --                          reach service_role / BYPASSRLS.
  --   authenticator_admin  — the trusted admin plane (auth, catalog, storage,
  --                          webhooks, realtime gate, service_role-key REST).
  --                          Member of service_role; a SEPARATE login + password.
  --
  -- Both NOLOGIN in the core backbone: each deployment grants LOGIN + a real
  -- password to its own credentials (dev below; prod via bootstrap-env), so the
  -- synced CLI template never ships a login-able role with a known password.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator_admin') THEN
    CREATE ROLE authenticator_admin NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Let postgres switch to these roles
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

-- Data plane: authenticator may ASSUME (SET ROLE) only the request roles. It is
-- deliberately NOT a member of service_role — that is the finding-6 boundary.
GRANT anon, authenticated TO authenticator;
-- Admin plane: a separate login role that can assume service_role (and only it).
GRANT service_role TO authenticator_admin;

-- Auth schema
CREATE SCHEMA IF NOT EXISTS pgstack;
GRANT USAGE ON SCHEMA pgstack TO authenticated, anon, service_role;

-- Supabase-compatible auth helper functions
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''),
    'anon'
  )
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS pgstack.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  encrypted_password text,
  role text NOT NULL DEFAULT 'authenticated',
  raw_user_meta jsonb DEFAULT '{}',
  raw_app_meta jsonb DEFAULT '{}',
  provider text NOT NULL DEFAULT 'email',
  providers text[] DEFAULT '{email}',
  -- No DEFAULT: a new user is UNVERIFIED until a code path explicitly confirms
  -- it. A DEFAULT now() auto-confirmed everyone, silently defeating
  -- REQUIRE_EMAIL_VERIFICATION (signup never set it, so the login gate's
  -- "email_confirmed_at IS NULL" check could never fire) — gemini audit P1.
  -- signup sets now() only when verification is off; admin/OAuth set it
  -- explicitly; email verification and email-change manage it.
  email_confirmed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE pgstack.users ENABLE ROW LEVEL SECURITY;

-- Users can only see their own record
CREATE POLICY users_self_select ON pgstack.users
  FOR SELECT TO authenticated
  USING (id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Refresh tokens are stored as SHA-256 hex hashes (since 2026-05 audit F6).
-- The plaintext token is returned to the client once and never persisted; a
-- DB dump or stolen backup no longer becomes a credential dump.
CREATE TABLE IF NOT EXISTS pgstack.refresh_tokens (
  id bigserial PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  family_id uuid DEFAULT gen_random_uuid(),
  revoked boolean DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE pgstack.refresh_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pgstack.oauth_sessions (
  state text PRIMARY KEY,
  code_verifier text NOT NULL,
  provider text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT now() + interval '10 minutes'
);
ALTER TABLE pgstack.oauth_sessions ENABLE ROW LEVEL SECURITY;

-- Email tokens (verify / recovery / magic link). Stored as SHA-256 hex hashes
-- since 2026-05 audit F6 — the plaintext is only emailed once and never kept
-- in the DB. Token shape: random URL-safe string generated by the proxy.
CREATE TABLE IF NOT EXISTS pgstack.email_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    token_type  text NOT NULL CHECK (token_type IN ('email_verification', 'recovery', 'magiclink')),
    -- The email an 'email_verification' token confirms, bound at issue time so a
    -- token minted for address X can never confirm a later address Y (gemini
    -- audit finding 2). NULL for recovery/magiclink (identity is the user_id).
    -- /verify sets email_confirmed_at only when this still equals the user's
    -- current email, and an email change revokes outstanding verification tokens.
    email       text,
    used_at     timestamptz,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pgstack.email_tokens ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON pgstack.email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON pgstack.email_tokens(user_id);

-- Storage tables
CREATE TABLE IF NOT EXISTS pgstack.storage_buckets (
  id text PRIMARY KEY,
  public boolean DEFAULT false,
  file_size_limit bigint DEFAULT 52428800,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  -- Audit F3 round 21: bucket id is also the on-disk subdirectory name
  -- under STORAGE_DIR. Restrict it to lowercase alnum + underscore + hyphen
  -- so it cannot collide with the reserved ".pgstack-staging" sweep root,
  -- cannot contain slashes (filesystem traversal), and stays portable to
  -- case-insensitive filesystems. The proxy enforces the same regex at
  -- CreateBucket; the CHECK is defence-in-depth for direct SQL inserts.
  CONSTRAINT bucket_id_on_disk_safe CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$')
);

ALTER TABLE pgstack.storage_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY storage_buckets_select ON pgstack.storage_buckets
  FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS pgstack.storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES pgstack.storage_buckets(id) ON DELETE CASCADE,
  name text NOT NULL,
  size bigint NOT NULL,
  mime_type text,
  data bytea,  -- NULL when STORAGE_BACKEND=disk (file stored on filesystem)
  metadata jsonb DEFAULT '{}',
  owner uuid REFERENCES pgstack.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(bucket_id, name)
);

CREATE INDEX IF NOT EXISTS idx_storage_objects_bucket ON pgstack.storage_objects(bucket_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_owner ON pgstack.storage_objects(owner);

ALTER TABLE pgstack.storage_objects ENABLE ROW LEVEL SECURITY;

-- Public bucket objects: anyone can read
CREATE POLICY storage_objects_public_select ON pgstack.storage_objects
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM pgstack.storage_buckets b WHERE b.id = bucket_id AND b.public = true));

-- Private bucket objects: only owner can read
CREATE POLICY storage_objects_owner_select ON pgstack.storage_objects
  FOR SELECT TO authenticated
  USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Authenticated users can insert (owner must match their ID)
CREATE POLICY storage_objects_insert ON pgstack.storage_objects
  FOR INSERT TO authenticated
  WITH CHECK (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Only owner can update their objects
CREATE POLICY storage_objects_update ON pgstack.storage_objects
  FOR UPDATE TO authenticated
  USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Only owner can delete their objects
CREATE POLICY storage_objects_delete ON pgstack.storage_objects
  FOR DELETE TO authenticated
  USING (owner = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Webhooks table. The signing secret is stored as AES-256-GCM ciphertext
-- under SECRETS_ENCRYPTION_KEY (since 2026-05 audit F1, round 7) — a
-- DB dump no longer leaks values that can forge X-Webhook-Signature.
-- Plaintext is held only in proxy memory after Refresh decrypts.
CREATE TABLE IF NOT EXISTS pgstack.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{*}',
  table_name text NOT NULL DEFAULT '*',
  secret_encrypted bytea,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE pgstack.webhooks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON pgstack.webhooks TO service_role;

-- Webhook delivery is driven by a per-table AFTER ROW trigger that emits a
-- table-aware event on the dedicated 'pgstack_webhooks' NOTIFY channel. The
-- proxy LISTENs on that channel and fans events out to matching webhooks.
CREATE OR REPLACE FUNCTION pgstack.webhook_notify() RETURNS trigger AS $$
DECLARE
  payload text;
BEGIN
  payload := json_build_object(
    'table',      TG_TABLE_NAME,
    'event',      TG_OP,
    'record',     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE row_to_json(OLD) END
  )::text;
  -- pg_notify has an 8000-byte payload limit. Rather than abort the DML, emit
  -- a body-less event so the webhook still fires (the consumer can re-fetch).
  IF octet_length(payload) <= 7900 THEN
    PERFORM pg_notify('pgstack_webhooks', payload);
  ELSE
    PERFORM pg_notify('pgstack_webhooks', json_build_object(
      'table', TG_TABLE_NAME, 'event', TG_OP, 'oversized', true
    )::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- enable/disable the per-table trigger. Called by the proxy when a webhook is
-- created for / removed from a specific table. Idempotent.
CREATE OR REPLACE FUNCTION pgstack.enable_webhook_trigger(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS pgstack_webhook_trg ON %s', tbl);
  EXECUTE format(
    'CREATE TRIGGER pgstack_webhook_trg AFTER INSERT OR UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION pgstack.webhook_notify()', tbl);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pgstack.disable_webhook_trigger(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS pgstack_webhook_trg ON %s', tbl);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION pgstack.enable_webhook_trigger(regclass)  TO service_role;
GRANT EXECUTE ON FUNCTION pgstack.disable_webhook_trigger(regclass) TO service_role;

-- Table grants for pgstack schema objects
GRANT SELECT ON pgstack.storage_buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgstack.storage_objects TO authenticated;
GRANT SELECT ON pgstack.storage_objects TO anon;
GRANT SELECT ON pgstack.users TO authenticated;

-- service_role is the trusted backend role the proxy's ADMIN connection assumes
-- (SET ROLE) for auth and admin operations. These DML grants were implicit when
-- the proxy connected as the superuser; an authenticator/service_role connection
-- needs them explicitly (gemini audit P2). BYPASSRLS on service_role lets the
-- auth writes through pgstack.users' RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pgstack.users, pgstack.refresh_tokens, pgstack.oauth_sessions, pgstack.email_tokens
  TO service_role;
-- Storage runs on the proxy's admin (service_role) connection: bucket/object
-- ownership is enforced in the handler + owner-locked upsert SQL, not by RLS,
-- so service_role needs full DML here too (gemini audit P2). Without these the
-- authenticator-based connection cannot touch storage at all once it stops
-- riding the superuser.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  pgstack.storage_buckets, pgstack.storage_objects
  TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgstack TO service_role;

-- ── Schema usage ─────────────────────────────────────────────────────────────
-- USAGE on the public schema is needed for any access at all; grants on
-- individual tables/functions still gate what each role can DO.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── service_role: full access (admin) ───────────────────────────────────────
-- service_role is the admin role used by the proxy when impersonating "no RLS"
-- via JWT role=service_role. It needs blanket privileges so internal
-- maintenance (catalog refresh, batch ops, migrations) keeps working.
-- CREATE on public is required for DDL through the (service_role-gated) /api/sql
-- endpoint and CLI migrations: creating tables/functions/policies. When the
-- proxy connected as the superuser this was implicit; the authenticator→
-- service_role model needs it explicit (gemini audit P2). This stays strictly
-- short of superuser — no COPY ... FROM PROGRAM, DROP DATABASE, or pg_authid.
GRANT CREATE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- ── anon / authenticated: NO blanket grants on public ───────────────────────
-- Since 2026-05 security audit (finding F3): newly-created tables in `public`
-- are NOT automatically readable by anon or writable by authenticated.
-- That used to be a footgun: any `CREATE TABLE foo (...)` in a migration
-- silently exposed `foo` through REST even when RLS was not yet enabled.
--
-- Per-table grants below are explicit, named, and only cover the demo /
-- test fixtures shipped with pgStack. Application tables MUST grant their
-- own privileges (e.g. via a migration that also enables RLS).
--
-- Sequence USAGE for anon/authenticated is similarly opt-in: each demo
-- table grants USAGE on its own _id_seq below.

-- (intentionally no `ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon|authenticated`)

-- ── Functions: revoke default PUBLIC EXECUTE ────────────────────────────────
-- Audit round 28 F1 (HIGH): PostgreSQL grants EXECUTE on every new function
-- to PUBLIC by default, which means anon/authenticated automatically inherit
-- EXECUTE. The REST RPC endpoint walks pg_proc and exposes any public.fn,
-- so a SECURITY DEFINER helper in `public` becomes anon-callable via
-- /rest/v1/rpc/{fn} the moment it's created — unless the author remembers
-- to revoke. Move the burden the other direction: PUBLIC has nothing by
-- default, the operator GRANTs EXECUTE explicitly for the functions they
-- intend to expose as RPC.
--
-- Round 29 F1: ALTER DEFAULT PRIVILEGES is scoped to the role that
-- CREATEd the rule. A bare ALTER DEFAULT PRIVILEGES only covers the
-- current bootstrap user; functions later created under a different
-- owner (postgres in some deployments, per-tenant roles, etc.) would
-- still grant PUBLIC EXECUTE. Loop over every plausible owner — same
-- pattern as the table-grants migration.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
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
    BEGIN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role',
        o);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;

-- Round-33 / audit F1: PostgreSQL's PUBLIC=EXECUTE built-in default on
-- functions cannot be overridden via ALTER DEFAULT PRIVILEGES REVOKE
-- alone. The REVOKE above only removes EXPLICIT grants from
-- pg_default_acl; if PUBLIC was there only via the built-in implicit
-- default (which is the usual case for fresh deployments), the REVOKE
-- is a no-op and every newly-created public.* function still has
-- PUBLIC=EXECUTE in its proacl. A DDL event trigger fires after every
-- CREATE FUNCTION / CREATE PROCEDURE in `public` and revokes PUBLIC
-- EXECUTE explicitly — that IS visible in proacl and survives the
-- next round-28 regression test.
CREATE OR REPLACE FUNCTION pgstack.revoke_public_execute_on_new_function()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    obj record;
BEGIN
    FOR obj IN
        SELECT * FROM pg_event_trigger_ddl_commands()
        WHERE command_tag IN ('CREATE FUNCTION', 'CREATE PROCEDURE')
          AND schema_name = 'public'
    LOOP
        BEGIN
            EXECUTE format(
                'REVOKE EXECUTE ON %s %s FROM PUBLIC',
                CASE WHEN obj.object_type = 'procedure' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
                obj.object_identity);
        EXCEPTION WHEN OTHERS THEN
            -- swallow per-object failures so a bad DDL doesn't break
            -- the whole transaction; the explicit REVOKE the operator
            -- writes for the affected fn will still take effect.
            NULL;
        END;
    END LOOP;
END $$;

-- Drop and recreate so init.sql is idempotent across container restarts.
DROP EVENT TRIGGER IF EXISTS pgstack_revoke_public_execute;
CREATE EVENT TRIGGER pgstack_revoke_public_execute
    ON ddl_command_end
    WHEN TAG IN ('CREATE FUNCTION', 'CREATE PROCEDURE')
    EXECUTE FUNCTION pgstack.revoke_public_execute_on_new_function();

-- Grant the proxy's trusted backend role (service_role) the access its realtime
-- gate needs on pg_reactive objects, WITHOUT coupling the pg_reactive extension
-- to pgstack's role model. The proxy now runs the WS/presence gate on its admin
-- (service_role) connection instead of a superuser, so service_role must be able
-- to EXECUTE pgr.subscription_meta and SELECT the per-query pgr._snap_* snapshot
-- tables (the snapshot read + its ACCESS SHARE lock). Those objects exist only
-- AFTER CREATE EXTENSION and the _snap tables are created at runtime by subscribe,
-- so a one-shot grant in this file cannot cover them — a DDL event trigger does.
-- No-op when service_role or the pgr schema is absent, so pg_reactive stays
-- usable standalone (gemini audit P2).
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
                -- (re)grant after install or an extension upgrade that drops+recreates
                -- subscription_meta.
                EXECUTE 'GRANT USAGE ON SCHEMA pgr TO service_role';
                IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'pgr' AND p.proname = 'subscription_meta') THEN
                    EXECUTE 'GRANT EXECUTE ON FUNCTION pgr.subscription_meta(text) TO service_role';
                END IF;
                EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA pgr TO service_role';
            ELSIF obj.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS') AND obj.schema_name = 'pgr' THEN
                -- per-query snapshot table just created by pgr.subscribe. It is
                -- built with CREATE UNLOGGED TABLE ... AS, whose command tag is
                -- 'CREATE TABLE AS' (NOT 'CREATE TABLE') — both are matched.
                EXECUTE format('GRANT SELECT ON %s TO service_role', obj.object_identity);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;  -- never let a grant failure abort the triggering DDL
        END;
    END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS pgstack_grant_pgr_to_service;
CREATE EVENT TRIGGER pgstack_grant_pgr_to_service
    ON ddl_command_end
    WHEN TAG IN ('CREATE EXTENSION', 'ALTER EXTENSION', 'CREATE TABLE', 'CREATE TABLE AS')
    EXECUTE FUNCTION pgstack.grant_pgr_access_to_service_role();
