#!/usr/bin/env node
// SECURITY.md invariant 24 (R5-1) — the startup role check is fail-closed against
// a PRIVILEGED login role, not just a service_role membership.
//
// verifyPoolRoles originally checked only that the data role was not a member of
// service_role and that the admin role's effective role was service_role. Both
// pass for a login role that is itself SUPERUSER or BYPASSRLS (e.g. DATABASE_URL
// pointed at `postgres`): the membership check says "fine" while a `RESET ROLE`
// would hand back full privileges. The hardened check reads the login role's
// attributes (rolsuper/rolbypassrls/rolcreaterole/rolcreatedb) on BOTH pools and
// is FATAL in production.
//
// This test boots the proxy one-off in PGSTACK_ENV=production with a SUPERUSER
// data DSN (postgres) and asserts it refuses to start (non-zero exit) with the
// dangerous-attribute reason — rather than serving traffic.
//
// Requires: `docker compose up -d` (the db must be reachable; the proxy-go image
// must be built). The run uses the existing stack's network + admin DSN.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const hex = (n) => randomBytes(n).toString("hex");
const sek = randomBytes(32).toString("base64");

console.log("\n=== startup rejects a privileged (SUPERUSER) login role ===");

const r = spawnSync(
  "docker",
  [
    "compose", "run", "--rm", "--no-deps",
    "-e", "PGSTACK_ENV=production",
    // The role under test: a SUPERUSER login role (postgres). The admin DSN is
    // left at the stack's valid authenticator_admin, so ONLY the data pool's
    // privileged login role can be the cause of a rejection.
    "-e", "DATABASE_URL=postgres://postgres:postgres@db:5432/pg_reactive_test",
    // Real-looking secrets so the production validator passes and execution
    // reaches verifyPoolRoles (the thing under test).
    "-e", `JWT_SECRET=${hex(24)}`,
    "-e", `ANON_KEY=${hex(16)}`,
    "-e", `SERVICE_ROLE_KEY=${hex(16)}`,
    "-e", `SECRETS_ENCRYPTION_KEY=${sek}`,
    "-e", "REQUIRE_AUTHENTICATED_WS=true",
    "-e", "SMTP_HOST=dummy", "-e", "SMTP_USER=u", "-e", "SMTP_PASS=p",
    // The dev base sets ENABLE_SQL_ENDPOINT=true, which the production validator
    // rejects before verifyPoolRoles runs — turn it off so this test exercises
    // the role check, not the (separately-tested) SQL-endpoint guard.
    "-e", "ENABLE_SQL_ENDPOINT=false",
    "proxy-go",
  ],
  { encoding: "utf-8", timeout: 90_000 },
);

const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
let fail = 0;
const check = (ok, msg) => { ok ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), fail++); };

// A non-zero exit means the proxy refused to start. (status is null if the
// process was killed by the timeout — that would mean it kept running = bad.)
check(r.status !== 0 && r.status !== null,
  `proxy refused to start with a superuser data DSN (exit ${r.status})`);
check(/dangerous attribute/i.test(out) && /SUPERUSER/i.test(out),
  "rejection names the dangerous login-role attributes (SUPERUSER/BYPASSRLS/…)");
check(!/pgstack listening/i.test(out),
  "proxy never reached 'listening' — it failed closed before serving");

if (fail > 0) {
  console.error(`\nFAIL: ${fail} — a privileged login role was NOT rejected at startup.`);
  console.error(out.split("\n").slice(-15).join("\n"));
  process.exit(1);
}
console.log("\nPASS: a SUPERUSER/BYPASSRLS proxy login role is rejected fail-closed at startup.");
