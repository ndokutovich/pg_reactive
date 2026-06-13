import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { generateJwtSecret, generateApiKey, randomHex } from "../lib/crypto.js";
// Bootstrap core is the security-critical part of the migration —
// roles, schemas, auth tables, RLS, default-deny grants, function-
// execute revoke. It lives in cli/templates/bootstrap-core.sql,
// which is generated from docker/init.sql by
// scripts/sync-cli-bootstrap.mjs. SoT lives in docker/init.sql;
// CI fails on drift. Round-31 Tier 2.3.
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_CORE_PATH = resolve(__dirname, "..", "..", "templates", "bootstrap-core.sql");
function readBootstrapCore() {
    try {
        return readFileSync(BOOTSTRAP_CORE_PATH, "utf-8");
    }
    catch (e) {
        throw new Error(`cli/templates/bootstrap-core.sql is missing — was the package built? ` +
            `(expected at ${BOOTSTRAP_CORE_PATH}). Run \`node scripts/sync-cli-bootstrap.mjs\` ` +
            `or rebuild the cli package.`);
    }
}
const DEFAULT_DB_PORT = 15432;
const DEFAULT_PROXY_PORT = 8080;
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
        // Login password for the powerless `authenticator` role the proxy
        // connects as (not the superuser). Hex so it is URL-safe in the DSN.
        const authenticatorPassword = randomHex(24);
        // Write docker-compose.yml
        await writeFile(join(projectDir, "docker-compose.yml"), generateDockerCompose());
        // Write .env
        await writeFile(join(projectDir, ".env"), generateEnv({ jwtSecret, anonKey, serviceRoleKey, authenticatorPassword }));
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
    # Ships PostgreSQL 16 + the pg_reactive extension; a stock postgres
    # image FATALs on shared_preload_libraries=pg_reactive below.
    image: ghcr.io/ndokutovich/pgstack-postgres:latest
    ports:
      - "\${PG_PORT:-${DEFAULT_DB_PORT}}:5432"
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${POSTGRES_DB:-${DEFAULT_DB_NAME}}
      # Makes the powerless 'authenticator' role LOGIN-able (the image's
      # 20-authenticator-login.sh applies it) so the proxy connects as a
      # non-superuser. Must match the proxy's DATABASE_URL below.
      AUTHENTICATOR_PASSWORD: \${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD required in .env}
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
    image: ghcr.io/ndokutovich/pgstack-proxy:latest
    ports:
      - "\${PROXY_PORT:-${DEFAULT_PROXY_PORT}}:${DEFAULT_PROXY_PORT}"
    environment:
      # Connect as the powerless 'authenticator' role (NOT the superuser): the
      # proxy SET ROLEs per request, so a compromise cannot bypass RLS by
      # default, COPY ... FROM PROGRAM, drop the database, or read pg_authid.
      DATABASE_URL: postgres://authenticator:\${AUTHENTICATOR_PASSWORD}@db:5432/\${POSTGRES_DB:-${DEFAULT_DB_NAME}}
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

# Login password for the powerless 'authenticator' role the PROXY connects as
# (not the superuser). Used by both the db and proxy services in
# docker-compose.yml. URL-safe.
AUTHENTICATOR_PASSWORD=${keys.authenticatorPassword}

# Proxy
PROXY_PORT=${DEFAULT_PROXY_PORT}

# Auth secrets (auto-generated, keep safe)
JWT_SECRET=${keys.jwtSecret}
ANON_KEY=${keys.anonKey}
SERVICE_ROLE_KEY=${keys.serviceRoleKey}

# Direct admin connection used by the CLI tooling ONLY (pgstack migration /
# generate — these run DDL, so they connect as the superuser). The network-
# exposed proxy does NOT use this; it connects as 'authenticator' (see
# docker-compose.yml).
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

# Login password for the powerless 'authenticator' role the proxy connects as
# (not the superuser). Must be URL-safe (it lands in the proxy DATABASE_URL):
#   openssl rand -hex 24
AUTHENTICATOR_PASSWORD=<openssl rand -hex 24>

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
    // Round-31 Tier 2.3: the SECURITY-CRITICAL backbone (roles, schemas,
    // auth tables, RLS, default-deny grants, function-execute revoke) is
    // read verbatim from cli/templates/bootstrap-core.sql — itself
    // generated from docker/init.sql by scripts/sync-cli-bootstrap.mjs.
    // SoT for that region is docker/init.sql; CI fails on drift between
    // the source region and the template. Anything CLI-specific (the
    // "how to add your own tables" guidance below) is appended here.
    const core = readBootstrapCore();
    return `-- pgStack bootstrap migration
${core}
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