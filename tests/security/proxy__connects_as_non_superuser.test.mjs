#!/usr/bin/env node
// SECURITY.md cross-cutting invariant #22 — the proxy connects to PostgreSQL as
// the powerless `authenticator` role, never the superuser. gemini audit P2.
//
// Pre-fix: DATABASE_URL pointed at `postgres` (the bootstrap superuser). A
// compromised proxy — SQL injection reaching the pool, an RCE, a leaked DSN —
// could bypass every RLS policy by default, COPY ... TO/FROM PROGRAM (arbitrary
// OS command execution), DROP DATABASE, and read pg_authid (every password
// hash). "Discipline" (remembering to SET ROLE on every query) cannot close
// this: one missed SET ROLE runs as the superuser.
//
// Post-fix: the proxy logs in as `authenticator` — NOSUPERUSER, NOBYPASSRLS,
// NOINHERIT — and SET ROLEs anon/authenticated/service_role per request. With
// NOINHERIT it holds NO privileges until it SET ROLEs, so the guarantee is
// STRUCTURAL, not behavioural.
//
// This test connects to PostgreSQL AS the proxy's login role and asserts it is
// powerless. It fails on the pre-fix configuration (a superuser login role
// passes every "denied" probe) and passes after.
//
// Requires: docker compose up (dev stack). The role/password default to the dev
// values; override with AUTHENTICATOR_PASSWORD / PG_DB if needed.

import { execFileSync as runProc } from "node:child_process";

const PW = process.env.AUTHENTICATOR_PASSWORD ?? "authenticator-dev-pw";
const ADMIN_PW = process.env.AUTHENTICATOR_ADMIN_PASSWORD ?? "authenticator-admin-dev-pw";
const DB = process.env.PG_DB ?? "pg_reactive_test";

let pass = 0;
let fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.error(`  FAIL: ${msg}`); }
}

// Run one SQL statement AS the authenticator login role. Returns {ok, out}:
// ok=true when psql exits 0, ok=false when the statement errored (the expected
// outcome for the "denied" probes).
function asAuthenticator(sql) {
  try {
    const out = runProc("docker", [
      "compose", "exec", "-T", "-e", `PGPASSWORD=${PW}`, "db",
      "psql", `host=127.0.0.1 user=authenticator dbname=${DB}`,
      "-v", "ON_ERROR_STOP=1", "-tAc", sql,
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: (out ?? "").trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

// Same, but AS the admin login role authenticator_admin (member of service_role).
function asAdmin(sql) {
  try {
    const out = runProc("docker", [
      "compose", "exec", "-T", "-e", `PGPASSWORD=${ADMIN_PW}`, "db",
      "psql", `host=127.0.0.1 user=authenticator_admin dbname=${DB}`,
      "-v", "ON_ERROR_STOP=1", "-tAc", sql,
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: (out ?? "").trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

function main() {
  // 0. We are actually connected as authenticator (the proxy's login role).
  const who = asAuthenticator("SELECT current_user");
  check(who.ok && who.out === "authenticator",
    `proxy login role is 'authenticator' (got ${JSON.stringify(who.out)})`);

  // 1. The login role is NOT a superuser and cannot bypass RLS; NOINHERIT.
  const attrs = asAuthenticator(
    "SELECT rolsuper||'/'||rolbypassrls||'/'||rolinherit FROM pg_roles WHERE rolname=current_user");
  check(attrs.ok && attrs.out === "false/false/false",
    `authenticator is NOSUPERUSER / NOBYPASSRLS / NOINHERIT (rolsuper/rolbypassrls/rolinherit = ${JSON.stringify(attrs.out)})`);

  // 2. No OS command execution — COPY ... TO PROGRAM is superuser-only.
  const copyProg = asAuthenticator("COPY (SELECT 1) TO PROGRAM 'echo pwned'");
  check(!copyProg.ok && /permission denied|pg_execute_server_program/i.test(copyProg.out),
    "COPY ... TO PROGRAM is denied (no OS command execution)");

  // 3. No credential theft — pg_authid (password hashes) is superuser-only.
  const authid = asAuthenticator("SELECT count(*) FROM pg_authid");
  check(!authid.ok && /permission denied/i.test(authid.out),
    "SELECT FROM pg_authid is denied (no password-hash exfiltration)");

  // 4. Zero privileges WITHOUT SET ROLE — NOINHERIT means app data is unreachable
  //    by default. A query that forgets to scope its role gets nothing.
  const noRole = asAuthenticator("SELECT count(*) FROM pgstack.users");
  check(!noRole.ok && /permission denied/i.test(noRole.out),
    "pgstack.users is denied without SET ROLE (NOINHERIT = powerless by default)");

  // 5. The data role CANNOT reach service_role — not directly, and not via
  //    RESET ROLE (back to the session role authenticator, which is NOT a member
  //    of service_role). This is the finding-6 boundary: a SQL injection on the
  //    data plane cannot escalate to BYPASSRLS / app-admin.
  const escalate = asAuthenticator("SET ROLE service_role");
  check(!escalate.ok && /permission denied to set role/i.test(escalate.out),
    "data role authenticator CANNOT SET ROLE service_role (no escalation)");
  const resetEscalate = asAuthenticator("RESET ROLE; SET ROLE service_role");
  check(!resetEscalate.ok && /permission denied to set role/i.test(resetEscalate.out),
    "data role cannot reach service_role via RESET ROLE either");
  // It can still assume the request roles it serves.
  const setAuthd = asAuthenticator("SET ROLE authenticated; SELECT 1");
  check(setAuthd.ok && setAuthd.out.includes("1"),
    "data role can still SET ROLE authenticated (serves anon/authenticated)");

  // 6. The SEPARATE admin login role authenticator_admin CAN assume service_role
  //    — so the admin pool still works. Power is split, not removed.
  const adminWho = asAdmin("SELECT current_user");
  check(adminWho.ok && adminWho.out === "authenticator_admin",
    `admin login role is 'authenticator_admin' (got ${JSON.stringify(adminWho.out)})`);
  const adminSuper = asAdmin("SELECT rolsuper FROM pg_roles WHERE rolname=current_user");
  check(adminSuper.ok && adminSuper.out === "f",
    "authenticator_admin is NOSUPERUSER (admin plane is still not the superuser)");
  const adminSetRole = asAdmin("SET ROLE service_role; SELECT 1");
  check(adminSetRole.ok && adminSetRole.out.includes("1"),
    "authenticator_admin CAN SET ROLE service_role (admin pool functional)");

  console.log(`\nProxy login-role isolation invariant: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
