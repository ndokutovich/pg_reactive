#!/usr/bin/env node
// SECURITY.md invariant 24 (R5-1 / R6-1 / R7-1 / R8-1 / R8-2) — the startup role
// check is fail-closed against EVERY way a proxy login role could hold or reach a
// privilege it must not. verifyPoolRoles (main.go) must reject a login role that:
//   - has any dangerous attribute: SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB,
//     INHERIT, REPLICATION;
//   - is a (transitive) member of anything outside its allowlist — data role:
//     anon/authenticated only; admin role: service_role only (catches a
//     dangerous predefined role like pg_execute_server_program, or service_role
//     reached through an intermediate role);
//   - owns any object or holds any DIRECT ACL grant (those apply with no SET
//     ROLE — including after a RESET ROLE — even under NOINHERIT);
//   - holds an allowlisted membership whose EDGE OPTIONS are unsafe (R8): the
//     allowlist bounds WHICH roles are reachable, but pg_auth_members also carries
//     per-grant options that bound HOW. WITH INHERIT TRUE (PG16 per-membership)
//     hands the role its member's privileges with NO SET ROLE despite a NOINHERIT
//     attribute; WITH ADMIN OPTION lets a login role without CREATEROLE delegate
//     the membership to other roles; WITH SET FALSE means the proxy cannot assume
//     the role at all. Healthy bootstrap grants are plain: admin=f inherit=f set=t.
//
// This test creates login roles exhibiting each property, boots the proxy
// one-off in PGSTACK_ENV=production pointed at them, and asserts it refuses to
// start (non-zero exit) with the right reason rather than serving traffic.
//
// Requires: `docker compose up -d` (db reachable; trust auth; proxy-go image
// built). The dev db uses POSTGRES_HOST_AUTH_METHOD=trust so the test roles
// connect without a real password.

import { spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const DB = process.env.PG_DB ?? "pg_reactive_test";
const ADMIN_PW = process.env.AUTHENTICATOR_ADMIN_PASSWORD ?? "authenticator-admin-dev-pw";
const hex = (n) => randomBytes(n).toString("hex");
const sek = randomBytes(32).toString("base64");

function psql(sql) {
  return execFileSync("docker",
    ["compose", "exec", "-T", "db", "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf-8" });
}

function setup() {
  psql(`DO $$ BEGIN
    -- member of a dangerous predefined role (pg_execute_server_program → COPY TO PROGRAM)
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_execprog') THEN
      CREATE ROLE r7_execprog LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r7_execprog; GRANT pg_execute_server_program TO r7_execprog;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_inherit') THEN
      CREATE ROLE r7_inherit LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r7_inherit;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_bypass') THEN
      CREATE ROLE r7_bypass LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
      GRANT anon, authenticated TO r7_bypass;
    END IF;
    -- REPLICATION + CREATEROLE + CREATEDB, but NOT superuser
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_attrs') THEN
      CREATE ROLE r7_attrs LOGIN NOINHERIT NOSUPERUSER REPLICATION CREATEROLE CREATEDB;
      GRANT anon, authenticated TO r7_attrs;
    END IF;
    -- a direct ACL grant (no inherited privilege; applies after RESET ROLE)
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_acl') THEN
      CREATE ROLE r7_acl LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r7_acl; GRANT SELECT ON pgstack.users TO r7_acl;
    END IF;
    -- owns an object
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_owner') THEN
      CREATE ROLE r7_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r7_owner;
      CREATE TABLE IF NOT EXISTS public.r7_owned(id int);
      ALTER TABLE public.r7_owned OWNER TO r7_owner;
    END IF;
    -- transitive membership in service_role via an intermediate role
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_mid') THEN
      CREATE ROLE r7_mid NOLOGIN; GRANT service_role TO r7_mid;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r7_trans') THEN
      CREATE ROLE r7_trans LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r7_trans; GRANT r7_mid TO r7_trans;
    END IF;
    -- R8: allowlisted membership, but the EDGE carries an unsafe option.
    -- WITH INHERIT TRUE → ambient authenticated privileges despite NOINHERIT (PG16).
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r8_inherit') THEN
      CREATE ROLE r8_inherit LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon TO r8_inherit; GRANT authenticated TO r8_inherit WITH INHERIT TRUE;
    END IF;
    -- WITH ADMIN OPTION → can GRANT authenticated to other roles without CREATEROLE.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r8_admin') THEN
      CREATE ROLE r8_admin LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon TO r8_admin; GRANT authenticated TO r8_admin WITH ADMIN OPTION;
    END IF;
    -- WITH SET FALSE → the proxy cannot SET LOCAL ROLE authenticated (fail-closed).
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r8_setfalse') THEN
      CREATE ROLE r8_setfalse LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon TO r8_setfalse; GRANT authenticated TO r8_setfalse WITH SET FALSE;
    END IF;
    -- admin plane: ADMIN OPTION on service_role = delegation / persistence path.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r8_admin_svc') THEN
      CREATE ROLE r8_admin_svc LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT service_role TO r8_admin_svc WITH ADMIN OPTION;
    END IF;
  END $$;`);
}
function teardown() {
  const roles = "r7_execprog,r7_inherit,r7_bypass,r7_attrs,r7_acl,r7_owner,r7_trans,r7_mid,r8_inherit,r8_admin,r8_setfalse,r8_admin_svc";
  try { psql(`DROP OWNED BY ${roles} CASCADE;`); } catch { /* ignore */ }
  try { psql(`DROP ROLE IF EXISTS ${roles};`); } catch { /* ignore */ }
}

const COMMON = [
  "-e", "PGSTACK_ENV=production",
  "-e", `JWT_SECRET=${hex(24)}`, "-e", `ANON_KEY=${hex(16)}`, "-e", `SERVICE_ROLE_KEY=${hex(16)}`,
  "-e", `SECRETS_ENCRYPTION_KEY=${sek}`, "-e", "REQUIRE_AUTHENTICATED_WS=true",
  "-e", "SMTP_HOST=dummy", "-e", "SMTP_USER=u", "-e", "SMTP_PASS=p",
  "-e", "ENABLE_SQL_ENDPOINT=false",
];
const dsn = (role) => `postgres://${role}:x@db:5432/${DB}`;
const validAdmin = `postgres://authenticator_admin:${ADMIN_PW}@db:5432/${DB}`;
const withAdmin = (k, v) => [[k, v], ["ADMIN_DATABASE_URL", validAdmin]];

function runProxy(extraEnv) {
  const r = spawnSync("docker",
    ["compose", "run", "--rm", "--no-deps", ...COMMON, ...extraEnv, "proxy-go"],
    { encoding: "utf-8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const cases = [
  { name: "SUPERUSER data DSN (also CREATEROLE/CREATEDB)", env: [["DATABASE_URL", dsn("postgres")]],        re: /data pool.*SUPERUSER/i },
  { name: "BYPASSRLS data DSN",                            env: withAdmin("DATABASE_URL", dsn("r7_bypass")), re: /data pool.*BYPASSRLS/i },
  { name: "INHERIT data DSN",                              env: withAdmin("DATABASE_URL", dsn("r7_inherit")), re: /data pool.*INHERIT/i },
  { name: "REPLICATION+CREATEROLE+CREATEDB data DSN",      env: withAdmin("DATABASE_URL", dsn("r7_attrs")),  re: /REPLICATION.*CREATEROLE.*CREATEDB|CREATEROLE.*CREATEDB.*REPLICATION/i },
  { name: "pg_execute_server_program member",             env: withAdmin("DATABASE_URL", dsn("r7_execprog")), re: /unexpected role.*pg_execute_server_program/i },
  { name: "transitive service_role via intermediate role", env: withAdmin("DATABASE_URL", dsn("r7_trans")),  re: /unexpected role.*service_role/i },
  { name: "direct ACL grant (SELECT on pgstack.users)",   env: withAdmin("DATABASE_URL", dsn("r7_acl")),    re: /owns objects or holds direct ACL grants/i },
  { name: "object ownership",                             env: withAdmin("DATABASE_URL", dsn("r7_owner")),  re: /owns objects or holds direct ACL grants/i },
  { name: "SUPERUSER admin DSN",                          env: [["ADMIN_DATABASE_URL", dsn("postgres")]],   re: /admin pool.*SUPERUSER/i },
  // R8 — allowlisted membership, unsafe edge option.
  { name: "data edge WITH INHERIT TRUE (ambient despite NOINHERIT)", env: withAdmin("DATABASE_URL", dsn("r8_inherit")),  re: /data pool.*unsafe options.*INHERIT TRUE/i },
  { name: "data edge WITH ADMIN OPTION (can delegate authenticated)", env: withAdmin("DATABASE_URL", dsn("r8_admin")),     re: /data pool.*unsafe options.*ADMIN OPTION/i },
  { name: "data edge WITH SET FALSE (proxy cannot assume the role)",  env: withAdmin("DATABASE_URL", dsn("r8_setfalse")),  re: /data pool.*unsafe options.*SET FALSE/i },
  { name: "admin edge service_role WITH ADMIN OPTION",               env: [["ADMIN_DATABASE_URL", dsn("r8_admin_svc")]],  re: /admin pool.*unsafe options.*ADMIN OPTION/i },
];

let fail = 0;
const check = (ok, msg) => { ok ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), fail++); };

console.log("\n=== startup rejects every privileged / over-privileged login role ===");
setup();
try {
  for (const c of cases) {
    const extra = c.env.flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const { status, out } = runProxy(extra);
    const exited = status !== 0 && status !== null; // null = timeout-killed = still running = bad
    const ok = exited && c.re.test(out);
    check(ok, `${c.name} → rejected fail-closed (exit ${status})`);
    if (!ok) console.error(out.split("\n").filter((l) => /fatal|dangerous|unexpected|owns|error/i.test(l)).slice(-4).join("\n"));
  }
} finally {
  teardown();
}

if (fail > 0) {
  console.error(`\nFAIL: ${fail} — an over-privileged login role was NOT rejected at startup.`);
  process.exit(1);
}
console.log("\nPASS: attributes, dangerous/transitive memberships, direct ACLs/ownership, and unsafe membership edge options all rejected fail-closed.");
