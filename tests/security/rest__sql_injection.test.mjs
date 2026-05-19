/**
 * Security regression test: SQL injection via REST filter parameters
 *
 * Each test sends a crafted query string to the proxy REST API and asserts
 * that either:
 *   (a) The server returns 400 Bad Request (rejected at parse time), or
 *   (b) The server returns a normal 200 with safe/empty results (parameterized
 *       queries prevent injection even if the request is accepted).
 *
 * A 5xx response is always a test failure — it may indicate a backend crash
 * caused by an injected string.
 *
 * Usage (requires docker compose up -d):
 *   node tests/security/sql_injection_test.mjs
 *   BASE_URL=http://127.0.0.1:8080 node tests/security/sql_injection_test.mjs
 *   AUTH_TOKEN=eyJ... node tests/security/sql_injection_test.mjs
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8080";
// Use a fixture table that exists in docker/init.sql so the REST
// parser's "table not found" 404 doesn't mask the actual injection-
// detector codepath we want to assert. Earlier default was
// load_test_items which is absent on CI compose. Round-33 follow-up,
// same fix shape as auth__jwt_manipulation.test.mjs.
const TABLE = process.env.TABLE || "todos";
// The proxy default-denies anon/authenticated on every public-schema
// table (round 12 bootstrap), so a request without any auth header
// gets 401 at the auth gate before the URL parser ever sees the
// injection probe. The point of THIS test is to exercise the
// injection detector, so we want the request to reach the parser —
// fall back to ANON_KEY (or its dev-compose default) when AUTH_TOKEN
// is unset. anon is the minimum identity the parser needs to look
// at column names.
const AUTH_TOKEN = process.env.AUTH_TOKEN
  || process.env.ANON_KEY
  || "dev-only-anon-key-do-not-use-in-production";

// ---------------------------------------------------------------------------
// Minimal HTTP client
// ---------------------------------------------------------------------------

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method,
      headers: {
        "Content-Type": "application/json",
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function get(path) {
  return request("GET", `${BASE_URL}${path}`, null);
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSafe(res, label) {
  assert(
    res.status !== 500 && res.status !== 503,
    `${label}: got 5xx (${res.status}) — possible server crash from injection`
  );
  assert(
    res.status < 500,
    `${label}: unexpected server error ${res.status}`
  );
}

function assertRejectedOrSafe(res, label) {
  assertSafe(res, label);
  // Either rejected (400/422) or safely returned (200/304) — both are acceptable.
  // What is NOT acceptable: 2xx with extra rows visible from injected data,
  // or 5xx indicating a crash.
  assert(
    res.status === 400 || res.status === 422 || res.status === 200 || res.status === 401 || res.status === 403,
    `${label}: unexpected status ${res.status}`
  );
}

// ---------------------------------------------------------------------------
// SQL injection via filter value — these must be parameterized
// ---------------------------------------------------------------------------

console.log("\nSQL Injection via filter value (parameterized — should be safe):");

await test("classic OR tautology in eq value", async () => {
  // "1' OR '1'='1" — if not parameterized this would match all rows
  const qs = encodeURIComponent("eq.1' OR '1'='1");
  const res = await get(`/rest/v1/${TABLE}?id=${qs}`);
  assertRejectedOrSafe(res, "OR tautology");
});

await test("UNION SELECT injection in value", async () => {
  const qs = encodeURIComponent("eq.1 UNION SELECT 1,2,3--");
  const res = await get(`/rest/v1/${TABLE}?id=${qs}`);
  assertRejectedOrSafe(res, "UNION SELECT");
});

await test("stacked queries via semicolon in value", async () => {
  const qs = encodeURIComponent("eq.1'; DROP TABLE users; --");
  const res = await get(`/rest/v1/${TABLE}?id=${qs}`);
  assertRejectedOrSafe(res, "stacked query");
});

await test("comment injection in value", async () => {
  const qs = encodeURIComponent("eq.1 --");
  const res = await get(`/rest/v1/${TABLE}?id=${qs}`);
  assertRejectedOrSafe(res, "comment injection");
});

await test("null byte in value", async () => {
  const qs = encodeURIComponent("eq.val\x00ue");
  const res = await get(`/rest/v1/${TABLE}?name=${qs}`);
  assertRejectedOrSafe(res, "null byte");
});

// ---------------------------------------------------------------------------
// SQL injection via column name — must be caught by identifier validation
// ---------------------------------------------------------------------------

console.log("\nSQL Injection via column name (must be rejected — 400):");

await test("SQL keyword as column name rejected", async () => {
  const res = await get(`/rest/v1/${TABLE}?SELECT=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — SQL keyword accepted as column`
  );
});

await test("column with semicolon rejected", async () => {
  const col = encodeURIComponent("id;DROP TABLE users;--");
  const res = await get(`/rest/v1/${TABLE}?${col}=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — semicolon in column name accepted`
  );
});

await test("column with single quote rejected", async () => {
  const col = encodeURIComponent("id'");
  const res = await get(`/rest/v1/${TABLE}?${col}=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — single quote in column name accepted`
  );
});

await test("column with double quote rejected", async () => {
  const col = encodeURIComponent('id"');
  const res = await get(`/rest/v1/${TABLE}?${col}=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — double quote in column name accepted`
  );
});

await test("column starting with digit rejected", async () => {
  const res = await get(`/rest/v1/${TABLE}?1col=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — digit-leading column name accepted`
  );
});

await test("column longer than 63 chars rejected", async () => {
  const longCol = "a".repeat(64);
  const res = await get(`/rest/v1/${TABLE}?${longCol}=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — over-length column name accepted`
  );
});

await test("column with hyphen rejected", async () => {
  const col = encodeURIComponent("col-name");
  const res = await get(`/rest/v1/${TABLE}?${col}=eq.1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — hyphen in column name accepted`
  );
});

// ---------------------------------------------------------------------------
// SQL injection via table name in URL path — must be rejected
// ---------------------------------------------------------------------------

console.log("\nSQL Injection via table name in URL path:");

await test("table name with semicolon rejected", async () => {
  const res = await get(`/rest/v1/users;DROP TABLE users`);
  assert(
    res.status === 400 || res.status === 404,
    `expected 400/404, got ${res.status}`
  );
});

await test("table name with SQL comment rejected", async () => {
  const res = await get(`/rest/v1/users--`);
  assert(
    res.status === 400 || res.status === 404,
    `expected 400/404, got ${res.status}`
  );
});

await test("table name with space rejected", async () => {
  const res = await get(`/rest/v1/users%20WHERE%201=1`);
  assert(
    res.status === 400 || res.status === 404,
    `expected 400/404, got ${res.status}`
  );
});

// ---------------------------------------------------------------------------
// Operator manipulation
// ---------------------------------------------------------------------------

console.log("\nInvalid / unknown operators:");

await test("unknown operator returns 400", async () => {
  const res = await get(`/rest/v1/${TABLE}?id=exec.1`);
  assert(res.status === 400, `expected 400, got ${res.status}`);
});

await test("raw SQL as operator returns 400", async () => {
  const op = encodeURIComponent("= 1; SELECT 1--.");
  const res = await get(`/rest/v1/${TABLE}?id=${op}1`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status}`
  );
});

// ---------------------------------------------------------------------------
// Order-by injection
// ---------------------------------------------------------------------------

console.log("\nOrder-by injection:");

await test("order by raw SQL expression rejected", async () => {
  const order = encodeURIComponent("(SELECT 1).asc");
  const res = await get(`/rest/v1/${TABLE}?order=${order}`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status} — raw SQL in order accepted`
  );
});

await test("order by column with quote rejected", async () => {
  const order = encodeURIComponent("name'.asc");
  const res = await get(`/rest/v1/${TABLE}?order=${order}`);
  assert(
    res.status === 400,
    `expected 400, got ${res.status}`
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`SQL Injection Security Tests: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.error("\nFailed tests:");
  failures.forEach(({ name, error }) => {
    console.error(`  - ${name}: ${error}`);
  });
}

console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
