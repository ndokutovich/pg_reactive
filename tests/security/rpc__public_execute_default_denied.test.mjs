#!/usr/bin/env node
// SECURITY.md cross-cutting invariant #2 — no PUBLIC EXECUTE on
// public.* functions.
//
// Round 28 F1 (HIGH): PostgreSQL grants EXECUTE on every new
// function to PUBLIC by default. The REST RPC endpoint walks
// pg_proc in `public` and exposes any function. The bootstrap now
// revokes PUBLIC EXECUTE; this test asserts that a function created
// WITHOUT an explicit GRANT EXECUTE TO {role} is NOT callable from
// the anon role via /rest/v1/rpc.
//
// Run requires service_role to create the test function (uses
// SERVICE_ROLE_KEY env, default dev key).

import { execFileSync as runProc } from "node:child_process";

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const ANON_KEY = process.env.ANON_KEY ?? "anon-key-12345";
const FN_NAME = `doctest_rpc_default_deny_${Date.now()}`;

function psql(sql) {
  runProc("docker", [
    "compose", "exec", "-T", "db",
    "psql", "-U", "postgres", "-d", "pg_reactive_test",
    "-v", "ON_ERROR_STOP=1",
    "-c", sql,
  ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

async function main() {
  // Create a function WITHOUT an explicit GRANT EXECUTE. Under the
  // bootstrap's default-deny posture, this means anon/authenticated
  // do NOT inherit EXECUTE and the RPC call should be refused.
  psql(`
    CREATE OR REPLACE FUNCTION public.${FN_NAME}()
    RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT 'forbidden-payload'::text $$;
  `);

  try {
    const res = await fetch(`${PROXY}/rest/v1/rpc/${FN_NAME}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON_KEY,
      },
      body: "{}",
    });

    if (res.status === 200) {
      const body = await res.text();
      console.error(
        `✗ anon RPC to a function with no explicit GRANT returned 200 — ` +
        `PUBLIC EXECUTE default-deny is not in force`,
      );
      console.error(`  body: ${body}`);
      process.exit(1);
    }

    if (res.status === 403 || res.status === 401 || res.status === 404) {
      console.log(
        `✓ anon RPC to non-granted function refused (status ${res.status}); ` +
        `PUBLIC EXECUTE is default-deny`,
      );
      process.exit(0);
    }

    console.error(
      `? unexpected status ${res.status} — neither 200 nor 4xx; ` +
      `investigate proxy behaviour`,
    );
    process.exit(1);
  } finally {
    psql(`DROP FUNCTION IF EXISTS public.${FN_NAME}();`);
  }
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
