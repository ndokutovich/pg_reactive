#!/usr/bin/env node
// SECURITY.md invariant 24 (R5-1 + R6-1) — the startup role check is fail-closed
// against EVERY way a proxy login role could hold or reach privileges it must
// not, not just SUPERUSER.
//
// verifyPoolRoles (main.go) must reject a login role that is SUPERUSER,
// BYPASSRLS, CREATEROLE, CREATEDB, INHERIT, or REPLICATION, or that is a
// (transitive) member of anything outside its allowlist — data role: anon/
// authenticated only; admin role: service_role only. A membership in a dangerous
// predefined role (pg_execute_server_program → COPY ... TO PROGRAM,
// pg_read_all_data → RLS bypass) or INHERIT (privileges held with no SET ROLE)
// would otherwise slip past the attribute checks.
//
// This test creates login roles with each dangerous property, boots the proxy
// one-off in PGSTACK_ENV=production pointed at them, and asserts it refuses to
// start (non-zero exit) with the right reason — rather than serving traffic.
//
// Requires: `docker compose up -d` (db reachable, trust auth; proxy-go image
// built). The dev db uses POSTGRES_HOST_AUTH_METHOD=trust, so the test roles
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

const ROLES = ["r6_execprog", "r6_inherit", "r6_bypass"];
function setup() {
  psql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r6_execprog') THEN
      CREATE ROLE r6_execprog LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r6_execprog;
      GRANT pg_execute_server_program TO r6_execprog;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r6_inherit') THEN
      CREATE ROLE r6_inherit LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      GRANT anon, authenticated TO r6_inherit;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='r6_bypass') THEN
      CREATE ROLE r6_bypass LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
      GRANT anon, authenticated TO r6_bypass;
    END IF;
  END $$;`);
}
function teardown() {
  for (const r of ROLES) { try { psql(`DROP ROLE IF EXISTS ${r};`); } catch { /* ignore */ } }
}

const COMMON = [
  "-e", "PGSTACK_ENV=production",
  "-e", `JWT_SECRET=${hex(24)}`, "-e", `ANON_KEY=${hex(16)}`, "-e", `SERVICE_ROLE_KEY=${hex(16)}`,
  "-e", `SECRETS_ENCRYPTION_KEY=${sek}`, "-e", "REQUIRE_AUTHENTICATED_WS=true",
  "-e", "SMTP_HOST=dummy", "-e", "SMTP_USER=u", "-e", "SMTP_PASS=p",
  // The dev base sets ENABLE_SQL_ENDPOINT=true, which the prod validator rejects
  // before verifyPoolRoles — disable it so the role check is what's exercised.
  "-e", "ENABLE_SQL_ENDPOINT=false",
];
const dsn = (role) => `postgres://${role}:x@db:5432/${DB}`;
const validAdmin = `postgres://authenticator_admin:${ADMIN_PW}@db:5432/${DB}`;

function runProxy(extraEnv) {
  const r = spawnSync("docker",
    ["compose", "run", "--rm", "--no-deps", ...COMMON, ...extraEnv, "proxy-go"],
    { encoding: "utf-8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const cases = [
  { name: "SUPERUSER data DSN",                 env: [["DATABASE_URL", dsn("postgres")]],                                  re: /data pool.*SUPERUSER/i },
  { name: "BYPASSRLS data DSN",                 env: [["DATABASE_URL", dsn("r6_bypass")],   ["ADMIN_DATABASE_URL", validAdmin]], re: /data pool.*BYPASSRLS/i },
  { name: "INHERIT data DSN",                   env: [["DATABASE_URL", dsn("r6_inherit")],  ["ADMIN_DATABASE_URL", validAdmin]], re: /data pool.*INHERIT/i },
  { name: "pg_execute_server_program member",   env: [["DATABASE_URL", dsn("r6_execprog")], ["ADMIN_DATABASE_URL", validAdmin]], re: /unexpected role.*pg_execute_server_program/i },
  { name: "SUPERUSER admin DSN",                env: [["ADMIN_DATABASE_URL", dsn("postgres")]],                            re: /admin pool.*SUPERUSER/i },
];

let fail = 0;
const check = (ok, msg) => { ok ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), fail++); };

console.log("\n=== startup rejects every privileged / over-privileged login role ===");
setup();
try {
  for (const c of cases) {
    const extra = c.env.flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const { status, out } = runProxy(extra);
    const exited = status !== 0 && status !== null; // null = killed by timeout = kept running = bad
    check(exited && c.re.test(out), `${c.name} → rejected fail-closed (exit ${status}, reason ${c.re})`);
    if (!(exited && c.re.test(out))) console.error(out.split("\n").filter((l) => /fatal|dangerous|unexpected|error/i.test(l)).slice(-4).join("\n"));
  }
} finally {
  teardown();
}

if (fail > 0) {
  console.error(`\nFAIL: ${fail} — a privileged/over-privileged login role was NOT rejected at startup.`);
  process.exit(1);
}
console.log("\nPASS: superuser / BYPASSRLS / INHERIT / dangerous-membership / privileged-admin DSNs all rejected fail-closed.");
