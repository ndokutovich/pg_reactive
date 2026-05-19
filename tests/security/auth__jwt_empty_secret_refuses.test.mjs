#!/usr/bin/env node
// SECURITY.md invariant #6 — empty JWT_SECRET ⇒ all auth refused.
//
// Round 26 F1 (CRITICAL): if the proxy boots without a JWT_SECRET
// and validates tokens against []byte(""), any attacker can forge a
// Bearer with sub=<victim_uuid> and walk into /auth/v1/user etc.
// The fix is fail-closed at GenerateToken/ValidateToken/requireJWT.
//
// This test forges an HS256 token signed with the empty key —
// exactly the attack from the audit — and asserts the proxy refuses.
//
// The unit test in proxy-go/auth/jwt_empty_secret_test.go covers the
// Go-side fail-closed; this file pins the network-visible behaviour
// so a future config bug that re-introduces the bypass at the HTTP
// layer also flunks.

import { createHmac } from "node:crypto";

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";

// HS256 forge with key="" — mirrors the round-26 audit PoC.
function forgeEmptyKeyToken(claims) {
  const enc = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(claims);
  const sig = createHmac("sha256", "")
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.${sig}`;
}

async function main() {
  // If the deployed proxy DOES have JWT_SECRET set (the common case),
  // a forged-with-empty-key token will be rejected by sig mismatch
  // and we'll see 401. That's also the correct outcome — the
  // invariant is "this token never authenticates anyone", which the
  // fail-closed empty-secret guard AND a real secret both satisfy.
  const token = forgeEmptyKeyToken({
    sub: "00000000-0000-0000-0000-000000000001",
    role: "service_role",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  const res = await fetch(`${PROXY}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    console.log(`✓ empty-key forged JWT refused (status ${res.status})`);
    process.exit(0);
  }

  console.error(
    `✗ empty-key forged JWT was accepted (status ${res.status}) — auth bypass`,
  );
  console.error(await res.text().catch(() => "<no body>"));
  process.exit(1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
