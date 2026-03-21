-- pgStack bootstrap: roles, schemas, and auth tables.
-- Runs on every container start (tmpfs wipes state).

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
END $$;

-- Let postgres switch to these roles
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

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
  email_confirmed_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE pgstack.users ENABLE ROW LEVEL SECURITY;

-- Users can only see their own record
CREATE POLICY users_self_select ON pgstack.users
  FOR SELECT TO authenticated
  USING (id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

CREATE TABLE IF NOT EXISTS pgstack.refresh_tokens (
  id bigserial PRIMARY KEY,
  token text UNIQUE NOT NULL,
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

-- Email tokens for verification, password reset, and magic links
CREATE TABLE IF NOT EXISTS pgstack.email_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
    token       text NOT NULL UNIQUE,
    token_type  text NOT NULL CHECK (token_type IN ('email_verification', 'recovery', 'magiclink')),
    used_at     timestamptz,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pgstack.email_tokens ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_email_tokens_token ON pgstack.email_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON pgstack.email_tokens(user_id);

-- Storage tables
CREATE TABLE IF NOT EXISTS pgstack.storage_buckets (
  id text PRIMARY KEY,
  public boolean DEFAULT false,
  file_size_limit bigint DEFAULT 52428800,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now()
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

-- Webhooks table
CREATE TABLE IF NOT EXISTS pgstack.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{*}',
  table_name text NOT NULL DEFAULT '*',
  secret text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE pgstack.webhooks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON pgstack.webhooks TO service_role;

-- Table grants for pgstack schema objects
GRANT SELECT ON pgstack.storage_buckets TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pgstack.storage_objects TO authenticated;
GRANT SELECT ON pgstack.storage_objects TO anon;
GRANT SELECT ON pgstack.users TO authenticated;

-- Default grants for public schema
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;

-- Test table (used by e2e_rest_test.mjs)
CREATE TABLE IF NOT EXISTS todos (
  id serial PRIMARY KEY,
  user_id uuid,
  title text,
  done boolean DEFAULT false
);

GRANT ALL ON todos TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO anon, authenticated, service_role;

-- Embedding test tables
CREATE TABLE IF NOT EXISTS authors (
  id serial PRIMARY KEY,
  name text NOT NULL,
  bio text
);

CREATE TABLE IF NOT EXISTS posts (
  id serial PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors(id),
  title text NOT NULL,
  body text,
  published boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS comments (
  id serial PRIMARY KEY,
  post_id integer NOT NULL REFERENCES posts(id),
  author_id integer REFERENCES authors(id),
  content text NOT NULL
);

GRANT ALL ON authors, posts, comments TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Seed data for embedding/RPC tests
INSERT INTO authors (name, bio) VALUES
  ('Alice', 'Writes about databases'),
  ('Bob', 'Writes about Rust');

INSERT INTO posts (author_id, title, body, published) VALUES
  (1, 'Intro to SQL', 'SQL basics...', true),
  (1, 'Advanced Joins', 'Join techniques...', true),
  (2, 'Rust for Beginners', 'Getting started...', false);

INSERT INTO comments (post_id, author_id, content) VALUES
  (1, 2, 'Great intro!'),
  (2, 2, 'Very helpful');

-- RPC test functions
CREATE OR REPLACE FUNCTION public.add_numbers(a integer, b integer)
RETURNS integer AS $$ SELECT a + b; $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.get_greeting(name text)
RETURNS text AS $$ SELECT 'Hello, ' || name || '!'; $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.list_active_authors()
RETURNS SETOF authors AS $$ SELECT * FROM authors WHERE id > 0; $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.get_post_stats()
RETURNS TABLE(total_posts bigint, published_posts bigint) AS $$
  SELECT COUNT(*)::bigint, COUNT(*) FILTER (WHERE published)::bigint FROM posts;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION public.add_numbers(integer, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_greeting(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_active_authors() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_post_stats() TO anon, authenticated, service_role;

-- Edge Functions registry
-- Runtimes:
--   embedded    = synchronous JS via goja VM inside the Go proxy (no DB access by default)
--   plv8        = JavaScript inside PostgreSQL (full ACID, no fetch)
--   plpython3u  = Python 3 inside PostgreSQL (full ACID, numpy/requests available via pip)
CREATE TABLE IF NOT EXISTS pgstack.edge_functions (
    name TEXT PRIMARY KEY,
    runtime TEXT NOT NULL DEFAULT 'embedded'
        CHECK (runtime IN ('embedded', 'plv8', 'plpython3u', 'deno')),
    verify_jwt BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    code TEXT,
    env_vars JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

GRANT SELECT ON pgstack.edge_functions TO service_role;

-- Auto-notify the proxy when a function is deployed or deleted so the
-- in-memory catalog refreshes without requiring an explicit POST /_refresh.
CREATE OR REPLACE FUNCTION pgstack.notify_fn_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('pgstack_fn_changed',
        COALESCE(NEW.name, OLD.name));
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER pgstack_fn_changed_trigger
AFTER INSERT OR UPDATE OR DELETE ON pgstack.edge_functions
FOR EACH ROW EXECUTE FUNCTION pgstack.notify_fn_changed();
