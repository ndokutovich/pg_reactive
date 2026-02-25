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

CREATE TABLE IF NOT EXISTS pgstack.refresh_tokens (
  id bigserial PRIMARY KEY,
  token text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  revoked boolean DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

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
