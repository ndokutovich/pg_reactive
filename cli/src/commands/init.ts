import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { generateJwtSecret, generateApiKey } from "../lib/crypto.js";

const DEFAULT_DB_PORT = 15432;
const DEFAULT_PROXY_PORT = 3000;
const DEFAULT_DB_NAME = "app";

export function registerInitCommand(program: Command): void {
  program
    .command("init <name>")
    .description("Create a new pgStack project")
    .option("-d, --dir <path>", "Parent directory", ".")
    .action(async (name: string, opts: { dir: string }) => {
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

      // Generate secrets
      const jwtSecret = generateJwtSecret();
      const anonKey = generateApiKey();
      const serviceRoleKey = generateApiKey();

      // Write docker-compose.yml
      await writeFile(
        join(projectDir, "docker-compose.yml"),
        generateDockerCompose()
      );

      // Write .env
      await writeFile(
        join(projectDir, ".env"),
        generateEnv({ jwtSecret, anonKey, serviceRoleKey })
      );

      // Write .env.example (without secrets)
      await writeFile(
        join(projectDir, ".env.example"),
        generateEnvExample()
      );

      // Write pgstack.config.json
      await writeFile(
        join(projectDir, "pgstack.config.json"),
        JSON.stringify(
          {
            projectName,
            dbPort: DEFAULT_DB_PORT,
            proxyPort: DEFAULT_PROXY_PORT,
            pgVersion: "16",
            schemas: ["public"],
          },
          null,
          2
        ) + "\n"
      );

      // Write .gitignore
      await writeFile(
        join(projectDir, ".gitignore"),
        generateGitignore()
      );

      // Write bootstrap migration
      await writeFile(
        join(projectDir, "migrations", "00000000000000_pgstack_init.sql"),
        generateBootstrapMigration()
      );

      // Write seed.sql
      await writeFile(
        join(projectDir, "seed.sql"),
        generateSeed()
      );

      console.log(chalk.green("\nProject created successfully!\n"));
      console.log("Next steps:");
      console.log(chalk.cyan(`  cd ${name}`));
      console.log(chalk.cyan("  npx pgstack dev"));
      console.log(chalk.cyan("  npx pgstack migration run"));
      console.log();
      console.log(`REST API:   ${chalk.yellow(`http://127.0.0.1:${DEFAULT_PROXY_PORT}/rest/v1/`)}`);
      console.log(`WebSocket:  ${chalk.yellow(`ws://127.0.0.1:${DEFAULT_PROXY_PORT}/ws/`)}`);
      console.log(`Health:     ${chalk.yellow(`http://127.0.0.1:${DEFAULT_PROXY_PORT}/health`)}`);
    });
}

function generateDockerCompose(): string {
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
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
`;
}

function generateEnv(keys: {
  jwtSecret: string;
  anonKey: string;
  serviceRoleKey: string;
}): string {
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

function generateEnvExample(): string {
  return `# pgStack Environment
# Copy to .env and fill in values

POSTGRES_PASSWORD=postgres
POSTGRES_DB=${DEFAULT_DB_NAME}
PG_PORT=${DEFAULT_DB_PORT}
PROXY_PORT=${DEFAULT_PROXY_PORT}

JWT_SECRET=<generate-a-random-secret-min-32-chars>
ANON_KEY=<generate-a-random-api-key>
SERVICE_ROLE_KEY=<generate-a-random-api-key>

DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${DEFAULT_DB_PORT}/${DEFAULT_DB_NAME}

# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
`;
}

function generateGitignore(): string {
  return `.env
node_modules/
types/database.ts
`;
}

function generateBootstrapMigration(): string {
  return `-- pgStack bootstrap migration
-- Creates auth schema, roles, and system tables

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

-- Grant roles to postgres (so SET LOCAL role works)
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

-- Auth schema
CREATE SCHEMA IF NOT EXISTS pgstack;

-- Users
CREATE TABLE pgstack.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text UNIQUE NOT NULL,
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  role                text NOT NULL DEFAULT 'authenticated',
  raw_user_meta       jsonb DEFAULT '{}',
  raw_app_meta        jsonb DEFAULT '{}',
  provider            text NOT NULL DEFAULT 'email',
  providers           text[] DEFAULT '{email}',
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- Refresh tokens
CREATE TABLE pgstack.refresh_tokens (
  id          bigserial PRIMARY KEY,
  token       text UNIQUE NOT NULL,
  user_id     uuid REFERENCES pgstack.users(id) ON DELETE CASCADE,
  revoked     boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- Sessions
CREATE TABLE pgstack.sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES pgstack.users(id) ON DELETE CASCADE,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  ip          inet,
  user_agent  text
);

-- Indexes
CREATE INDEX idx_pgstack_refresh_tokens_user ON pgstack.refresh_tokens(user_id);
CREATE INDEX idx_pgstack_refresh_tokens_token ON pgstack.refresh_tokens(token) WHERE NOT revoked;
CREATE INDEX idx_pgstack_sessions_user ON pgstack.sessions(user_id);
CREATE INDEX idx_pgstack_users_email ON pgstack.users(email);

-- Grant access: anon can read public schema, authenticated can CRUD public schema
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
`;
}

function generateSeed(): string {
  return `-- Seed data
-- Run with: npx pgstack db seed

-- Add your seed data here, for example:
-- INSERT INTO products (name, price) VALUES
--   ('Widget', 9.99),
--   ('Gadget', 19.99);
`;
}
