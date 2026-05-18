import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { generateJwtSecret, generateApiKey } from "../lib/crypto.js";
const DEFAULT_DB_PORT = 15432;
const DEFAULT_PROXY_PORT = 3000;
const DEFAULT_DB_NAME = "app";
export function registerInitCommand(program) {
    program
        .command("init <name>")
        .description("Create a new pgStack project")
        .option("-d, --dir <path>", "Parent directory", ".")
        .action(async (name, opts) => {
        const projectDir = resolve(opts.dir, name);
        if (existsSync(projectDir)) {
            console.error(chalk.red(`Directory "${name}" already exists.`));
            process.exit(1);
        }
        const projectName = basename(projectDir);
        console.log(chalk.blue(`Creating pgStack project: ${projectName}`));
        // Create directories
        await mkdir(resolve(projectDir, "migrations"), { recursive: true });
        await mkdir(resolve(projectDir, "types"), { recursive: true });
        await mkdir(resolve(projectDir, "public"), { recursive: true });
        // Generate secrets
        const jwtSecret = generateJwtSecret();
        const anonKey = generateApiKey();
        const serviceRoleKey = generateApiKey();
        // Write docker-compose.yml
        await writeFile(join(projectDir, "docker-compose.yml"), generateDockerCompose());
        // Write .env
        await writeFile(join(projectDir, ".env"), generateEnv({ jwtSecret, anonKey, serviceRoleKey }));
        // Write .env.example (without secrets)
        await writeFile(join(projectDir, ".env.example"), generateEnvExample());
        // Write pgstack.config.json
        await writeFile(join(projectDir, "pgstack.config.json"), JSON.stringify({
            projectName,
            dbPort: DEFAULT_DB_PORT,
            proxyPort: DEFAULT_PROXY_PORT,
            pgVersion: "16",
            schemas: ["public"],
        }, null, 2) + "\n");
        // Write .gitignore
        await writeFile(join(projectDir, ".gitignore"), generateGitignore());
        // Write bootstrap migration
        await writeFile(join(projectDir, "migrations", "00000000000000_pgstack_init.sql"), generateBootstrapMigration());
        // Write seed.sql
        await writeFile(join(projectDir, "seed.sql"), generateSeed());
        // Write public/index.html starter page
        await writeFile(join(projectDir, "public", "index.html"), generateStarterPage(projectName));
        console.log(chalk.green("\nProject created successfully!\n"));
        console.log("Next steps:");
        console.log(chalk.cyan(`  cd ${name}`));
        console.log(chalk.cyan("  npx pgstack dev"));
        console.log(chalk.cyan("  npx pgstack migration run"));
        console.log();
        console.log(`Your app:   ${chalk.yellow(`http://127.0.0.1:${DEFAULT_PROXY_PORT}/`)}`);
        console.log(`REST API:   ${chalk.yellow(`http://127.0.0.1:${DEFAULT_PROXY_PORT}/rest/v1/`)}`);
        console.log(`WebSocket:  ${chalk.yellow(`ws://127.0.0.1:${DEFAULT_PROXY_PORT}/ws/`)}`);
        console.log(`Health:     ${chalk.yellow(`http://127.0.0.1:${DEFAULT_PROXY_PORT}/health`)}`);
    });
}
function generateDockerCompose() {
    return `services:
  db:
    image: postgres:16-bookworm
    ports:
      - "\${PG_PORT:-${DEFAULT_DB_PORT}}:5432"
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${POSTGRES_DB:-${DEFAULT_DB_NAME}}
    volumes:
      - pgdata:/var/lib/postgresql/data
    command: >
      postgres
      -c shared_preload_libraries=pg_reactive
      -c pg_reactive.max_subscriptions=1024
      -c log_min_messages=warning
    healthcheck:
      test: pg_isready -U postgres
      interval: 2s
      timeout: 5s
      retries: 15

  proxy:
    image: pgstack/proxy:latest
    ports:
      - "\${PROXY_PORT:-${DEFAULT_PROXY_PORT}}:${DEFAULT_PROXY_PORT}"
    environment:
      DATABASE_URL: postgres://postgres:\${POSTGRES_PASSWORD:-postgres}@db:5432/\${POSTGRES_DB:-${DEFAULT_DB_NAME}}
      JWT_SECRET: \${JWT_SECRET}
      ANON_KEY: \${ANON_KEY}
      SERVICE_ROLE_KEY: \${SERVICE_ROLE_KEY}
      LISTEN_ADDR: 0.0.0.0:${DEFAULT_PROXY_PORT}
      PUBLIC_DIR: /public
    volumes:
      - ./public:/public:ro
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
`;
}
function generateEnv(keys) {
    return `# pgStack Environment
# Generated — do NOT commit this file

# PostgreSQL
POSTGRES_PASSWORD=postgres
POSTGRES_DB=${DEFAULT_DB_NAME}
PG_PORT=${DEFAULT_DB_PORT}

# Proxy
PROXY_PORT=${DEFAULT_PROXY_PORT}

# Auth secrets (auto-generated, keep safe)
JWT_SECRET=${keys.jwtSecret}
ANON_KEY=${keys.anonKey}
SERVICE_ROLE_KEY=${keys.serviceRoleKey}

# Derived (used by CLI and proxy)
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${DEFAULT_DB_PORT}/${DEFAULT_DB_NAME}

# OAuth (uncomment and fill to enable)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
`;
}
function generateEnvExample() {
    return `# pgStack Environment
# Copy to .env and fill in values. EVERY secret below MUST be replaced before
# the proxy is exposed to the network — the strict production validator
# (PGSTACK_ENV=production) will refuse to start with placeholder values.
#
# Generate each secret with:
#   for v in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRETS_ENCRYPTION_KEY; do
#     printf '%s=%s\\n' "$v" "$(openssl rand -base64 32)" >> .env
#   done

POSTGRES_PASSWORD=<openssl rand -base64 32>
POSTGRES_DB=${DEFAULT_DB_NAME}
PG_PORT=${DEFAULT_DB_PORT}
PROXY_PORT=${DEFAULT_PROXY_PORT}

JWT_SECRET=<openssl rand -base64 32>
ANON_KEY=<openssl rand -base64 32>
SERVICE_ROLE_KEY=<openssl rand -base64 32>

# Encrypts edge function env vars and webhook signing secrets at rest.
# Required if you create any encrypted webhook or store env vars on
# pgstack.edge_functions; otherwise the proxy will refuse those operations.
SECRETS_ENCRYPTION_KEY=<openssl rand -base64 32>

DATABASE_URL=postgres://postgres:\${POSTGRES_PASSWORD}@127.0.0.1:${DEFAULT_DB_PORT}/${DEFAULT_DB_NAME}

# Set to "production" to enable the fail-fast validator (refuses placeholders,
# dev flags like ENABLE_SQL_ENDPOINT, ALLOW_PERMISSIVE_CORS, etc.).
# PGSTACK_ENV=production

# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
`;
}
function generateGitignore() {
    return `.env
node_modules/
types/database.ts
`;
}
function generateBootstrapMigration() {
    // Kept in sync with docker/init.sql — same hardened shape:
    //  - refresh/email tokens stored as SHA-256 hashes, never plaintext
    //  - refresh tokens carry a family_id for stolen-token reuse detection
    //  - RLS enabled on every auth table; row visibility scoped to JWT sub
    //  - oauth_sessions for PKCE state validation
    //  - no blanket public-schema GRANTs; default-deny, opt-in per-table
    //
    // If you change the bootstrap, update docker/init.sql at the same time
    // (and vice versa) — they describe the same logical schema.
    return `-- pgStack bootstrap migration
-- Roles + auth schema + hardened auth tables.

-- Roles (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- Let postgres switch into those roles via SET LOCAL ROLE.
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

-- Auth + helper schemas
CREATE SCHEMA IF NOT EXISTS pgstack;
GRANT USAGE ON SCHEMA pgstack TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Supabase-compatible helpers for RLS policy expressions.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''), 'anon')
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

-- Users.
CREATE TABLE IF NOT EXISTS pgstack.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text UNIQUE NOT NULL,
  encrypted_password  text,
  role                text NOT NULL DEFAULT 'authenticated',
  raw_user_meta       jsonb DEFAULT '{}',
  raw_app_meta        jsonb DEFAULT '{}',
  provider            text NOT NULL DEFAULT 'email',
  providers           text[] DEFAULT '{email}',
  email_confirmed_at  timestamptz,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);
ALTER TABLE pgstack.users ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only see their own row.
DROP POLICY IF EXISTS users_self_select ON pgstack.users;
CREATE POLICY users_self_select ON pgstack.users
  FOR SELECT TO authenticated
  USING (id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);

-- Refresh tokens are stored as SHA-256 hashes; plaintext leaves the proxy
-- exactly once (to the client). family_id supports reuse-detection: any
-- replay of a revoked token revokes the whole family.
CREATE TABLE IF NOT EXISTS pgstack.refresh_tokens (
  id          bigserial PRIMARY KEY,
  token_hash  text UNIQUE NOT NULL,
  user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  family_id   uuid DEFAULT gen_random_uuid(),
  revoked     boolean DEFAULT false,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE pgstack.refresh_tokens ENABLE ROW LEVEL SECURITY;

-- Email tokens (verification / recovery / magic link), also hashed at rest.
CREATE TABLE IF NOT EXISTS pgstack.email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  token_type  text NOT NULL CHECK (token_type IN ('email_verification', 'recovery', 'magiclink')),
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pgstack.email_tokens ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON pgstack.email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON pgstack.email_tokens(user_id);

-- OAuth state + PKCE verifier per outstanding flow.
CREATE TABLE IF NOT EXISTS pgstack.oauth_sessions (
  state         text PRIMARY KEY,
  code_verifier text NOT NULL,
  provider      text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  expires_at    timestamptz DEFAULT now() + interval '10 minutes'
);
ALTER TABLE pgstack.oauth_sessions ENABLE ROW LEVEL SECURITY;

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_pgstack_refresh_tokens_user
  ON pgstack.refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pgstack_refresh_tokens_hash
  ON pgstack.refresh_tokens(token_hash) WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS idx_pgstack_users_email
  ON pgstack.users(email);

-- public-schema access: default-deny, opt in per table.
-- The unauthenticated 'anon' role gets *only* what you explicitly GRANT.
-- The 'authenticated' role likewise needs explicit grants combined with RLS
-- policies that scope visibility. Avoid blanket "GRANT ALL ON ALL TABLES" —
-- it bypasses the RLS posture this stack relies on.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- service_role bypasses RLS (declared NOLOGIN BYPASSRLS above) so it does
-- need broad object access for admin tasks driven by SERVICE_ROLE_KEY.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

-- Functions: revoke the PostgreSQL default of PUBLIC EXECUTE.
--
-- The REST endpoint at /rest/v1/rpc/{fn} walks pg_proc and exposes any
-- function in the public schema. PostgreSQL grants EXECUTE on every
-- new function to PUBLIC by default, which means anon and authenticated
-- would inherit the right to call it via REST the moment it is created
-- — even (and especially) SECURITY DEFINER helpers that were meant to
-- be invoked only from triggers or other definer-context paths.
-- Default-deny here, the same way tables already work.
--
-- ALTER DEFAULT PRIVILEGES is scoped to the role that CREATEd the rule,
-- so we loop over the plausible owners (postgres + current_user). A
-- bare ALTER DEFAULT PRIVILEGES would only cover whichever role ran
-- this bootstrap and miss future per-tenant owners. Failures swallowed
-- — the rule may not yet exist for a given owner.
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

-- For each NEW user table you add under public/, explicitly grant only
-- what the API needs and rely on RLS to scope rows. Example:
--
--   CREATE TABLE public.todos (...);
--   ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY todos_owner ON public.todos
--     FOR ALL TO authenticated
--     USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
--   GRANT SELECT                         ON public.todos TO anon;  -- if public-readable
--
-- For RPC-exposed functions, GRANT EXECUTE explicitly (default-deny applies):
--
--   CREATE FUNCTION public.search_users(q text) RETURNS SETOF users ...;
--   GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;
`;
}
function generateSeed() {
    return `-- Seed data
-- Run with: npx pgstack db seed

-- Add your seed data here, for example:
-- INSERT INTO products (name, price) VALUES
--   ('Widget', 9.99),
--   ('Gadget', 19.99);
`;
}
function generateStarterPage(projectName) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${projectName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #111827; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 2rem; max-width: 420px; width: 100%; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #6b7280; margin-bottom: 1.5rem; }
    .links { display: flex; flex-direction: column; gap: 0.5rem; }
    .links a { color: #2563eb; text-decoration: none; font-size: 0.95rem; }
    .links a:hover { text-decoration: underline; }
    .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #d1d5db; margin-right: 6px; vertical-align: middle; }
    .status.ok { background: #10b981; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${projectName}</h1>
    <p>Your pgStack app is running. <span class="status" id="dot"></span><span id="health">checking...</span></p>
    <div class="links">
      <a href="/rest/v1/">REST API</a>
      <a href="/health">Health check</a>
      <a href="/studio/">Studio</a>
    </div>
  </div>
  <script>
    fetch('/health').then(r => r.json()).then(() => {
      document.getElementById('dot').classList.add('ok');
      document.getElementById('health').textContent = 'healthy';
    }).catch(() => {
      document.getElementById('health').textContent = 'unreachable';
    });
  </script>
</body>
</html>
`;
}
//# sourceMappingURL=init.js.map