/**
 * Security regression test: JWT manipulation edge cases
 *
 * Tests that the proxy correctly rejects malformed, expired, tampered, and
 * algorithmically-confused JWT tokens with HTTP 401.
 *
 * Usage (requires docker compose up -d with JWT_SECRET set):
 *   JWT_SECRET=test node tests/security/jwt_manipulation_test.mjs
 *   BASE_URL=http://127.0.0.1:8080 JWT_SECRET=mysecret node tests/security/jwt_manipulation_test.mjs
 *
 * The test generates tokens itself using standard base64 so it has no npm
 * dependencies beyond Node.js built-ins.
 */

import http from "node:http";
import https from "node:https";
import { createHmac } from "node:crypto";
import { URL } from "node:url";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8080";
// Must match JWT_SECRET configured in the proxy (docker-compose env).
const JWT_SECRET = process.env.JWT_SECRET || "test";
// A REST endpoint that requires auth — 401 when no/bad token, 200/400 with
// valid token. Round 32 follow-up: use /auth/v1/user which fires the JWT
// gate BEFORE any table lookup. Earlier the default was
// /rest/v1/load_test_items but on a clean compose the table doesn't
// exist, so the request hit a 404 from the table-resolution path
// before the auth gate could speak — every assertion saw "got 404,
// expected 401" and we couldn't distinguish auth-pass from
// table-miss. /auth/v1/user has no such dependency.
const PROTECTED_PATH = process.env.PROTECTED_PATH || "/auth/v1/user";

// ---------------------------------------------------------------------------
// Minimal JWT builder (no external deps)
// ---------------------------------------------------------------------------

function base64UrlEncode(obj) {
  const json = typeof obj === "string" ? obj : JSON.stringify(obj);
  return Buffer.from(json)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJWT(header, payload, secret) {
  const headerEnc = base64UrlEncode(header);
  const payloadEnc = base64UrlEncode(payload);
  const sigInput = `${headerEnc}.${payloadEnc}`;

  if (secret === null) {
    // "none" algorithm: empty signature
    return `${sigInput}.`;
  }

  const sig = createHmac("sha256", secret)
    .update(sigInput)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${sigInput}.${sig}`;
}

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

// ---- Standard HS256 header ----
const HS256_HEADER = { alg: "HS256", typ: "JWT" };

function validPayload(overrides = {}) {
  return {
    sub: "test-user-001",
    role: "authenticated",
    iat: nowSecs(),
    exp: nowSecs() + 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function request(path, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${BASE_URL}${path}`);
    const lib = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.end();
  });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nJWT Auth — valid token baseline:");

await test("valid HS256 token returns non-401", async () => {
  const token = makeJWT(HS256_HEADER, validPayload(), JWT_SECRET);
  const res = await request(PROTECTED_PATH, token);
  assert(
    res.status !== 401,
    `valid token rejected with 401 — check JWT_SECRET matches proxy config`
  );
  assert(res.status < 500, `server error ${res.status}`);
});

console.log("\nJWT Auth — expired token:");

await test("expired token returns 401", async () => {
  // exp = 60 seconds ago
  const token = makeJWT(HS256_HEADER, validPayload({ exp: nowSecs() - 60 }), JWT_SECRET);
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status} for expired token`);
});

await test("token expiring far in the past returns 401", async () => {
  // exp = Unix epoch (Jan 1 1970)
  const token = makeJWT(HS256_HEADER, validPayload({ exp: 1 }), JWT_SECRET);
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

console.log("\nJWT Auth — wrong secret:");

await test("token signed with wrong secret returns 401", async () => {
  const token = makeJWT(HS256_HEADER, validPayload(), "completely-wrong-secret");
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status} for wrong-secret token`);
});

await test("token signed with empty secret returns 401", async () => {
  const token = makeJWT(HS256_HEADER, validPayload(), "");
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status} for empty-secret token`);
});

console.log("\nJWT Auth — algorithm confusion:");

await test("alg:none token returns 401", async () => {
  const noneHeader = { alg: "none", typ: "JWT" };
  // Craft a token with no signature (the "none" algorithm attack)
  const token = makeJWT(noneHeader, validPayload(), null);
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status} — alg:none accepted`);
});

await test("alg:NONE (uppercase) token returns 401", async () => {
  const noneHeader = { alg: "NONE", typ: "JWT" };
  const token = makeJWT(noneHeader, validPayload(), null);
  const res = await request(PROTECTED_PATH, token);
  assert(res.status === 401, `expected 401, got ${res.status} — alg:NONE accepted`);
});

await test("alg:HS512 token returns 401 (unexpected algorithm)", async () => {
  const hs512Header = { alg: "HS512", typ: "JWT" };
  // Sign with HS512 (sha512), proxy expects HS256
  const headerEnc = Buffer.from(JSON.stringify(hs512Header))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const payloadEnc = Buffer.from(JSON.stringify(validPayload()))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const sigInput = `${headerEnc}.${payloadEnc}`;
  const sig = createHmac("sha512", JWT_SECRET)
    .update(sigInput)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const token = `${sigInput}.${sig}`;
  const res = await request(PROTECTED_PATH, token);
  assert(
    res.status === 401,
    `expected 401, got ${res.status} — HS512 token accepted when proxy expects HS256`
  );
});

console.log("\nJWT Auth — missing / invalid claims:");

await test("token without sub claim returns 401", async () => {
  const payload = { role: "authenticated", exp: nowSecs() + 3600 };
  const token = makeJWT(HS256_HEADER, payload, JWT_SECRET);
  const res = await request(PROTECTED_PATH, token);
  assert(
    res.status === 401,
    `expected 401, got ${res.status} — token without sub accepted`
  );
});

await test("token with empty sub returns 401", async () => {
  const token = makeJWT(HS256_HEADER, validPayload({ sub: "" }), JWT_SECRET);
  const res = await request(PROTECTED_PATH, token);
  assert(
    res.status === 401,
    `expected 401, got ${res.status} — token with empty sub accepted`
  );
});

console.log("\nJWT Auth — malformed tokens:");

await test("empty token returns 401", async () => {
  const res = await request(PROTECTED_PATH, "");
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await test("garbage string returns 401", async () => {
  const res = await request(PROTECTED_PATH, "not-a-jwt-at-all");
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await test("two-segment token returns 401", async () => {
  const res = await request(PROTECTED_PATH, "header.payload");
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await test("four-segment token returns 401", async () => {
  const res = await request(PROTECTED_PATH, "a.b.c.d");
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await test("token with tampered payload returns 401", async () => {
  // Build a valid token, then swap the payload with an escalated one
  const goodToken = makeJWT(HS256_HEADER, validPayload(), JWT_SECRET);
  const parts = goodToken.split(".");

  // Replace payload with service_role claims, keep original signature
  const evilPayload = base64UrlEncode(
    validPayload({ role: "service_role", sub: "evil-user" })
  );
  const tamperedToken = `${parts[0]}.${evilPayload}.${parts[2]}`;

  const res = await request(PROTECTED_PATH, tamperedToken);
  assert(
    res.status === 401,
    `expected 401, got ${res.status} — tampered payload accepted`
  );
});

await test("no Authorization header returns 401", async () => {
  const res = await request(PROTECTED_PATH, undefined);
  assert(
    res.status === 401,
    `expected 401, got ${res.status} — unauthenticated request accepted`
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`JWT Manipulation Tests: ${passed} passed, ${failed} failed`);

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
