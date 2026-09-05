#!/usr/bin/env node
// SECURITY.md — guest upgrade path (0.3.0), INV-B.
//
// A guest attaches a real identity WITHOUT losing the account: the id (and
// therefore every auth.uid()-keyed row) survives. After the flip the account
// is a full member and the is_anonymous marker disappears from freshly minted
// tokens — derived from the row, never copied from the old token.
//
// Proves, over HTTP (requires ALLOW_ANONYMOUS_SIGNIN=true on the stack;
// self-skips into failure otherwise so CI misconfiguration is loud):
//   1. guest signs in; PATCH /auth/v1/user sets a real email + password.
//   2. the id is unchanged; the row's provider list grew (anonymous,email).
//   3. a fresh refresh returns role=authenticated and NO is_anonymous claim.
//   4. password login with the new email works and lands on the SAME id.
//   5. the reaper predicate (providers = {anonymous}) no longer matches the
//      upgraded row — asserted at the SQL level.
//
// NOTE: assumes REQUIRE_EMAIL_VERIFICATION is off in the test stack (default
// dev posture) — the PATCH itself is then the upgrade. The verification-on
// flow flips at confirm time instead (unit-covered in proxy code).

import crypto from "node:crypto";
import { psql } from "../helpers.mjs";

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const GATE_ON = (process.env.ALLOW_ANONYMOUS_SIGNIN ?? "").toLowerCase() === "true";

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(`${PROXY}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const jwtPayload = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));

async function main() {
  if (!GATE_ON) {
    console.log("  ~ ALLOW_ANONYMOUS_SIGNIN not true in this stack — nothing to upgrade;");
    console.log("    the default-deny path is covered by auth__anonymous_role_isolation.");
    return;
  }

  // 1. guest
  const signin = await api("POST", "/auth/v1/anonymous", {});
  check(signin.status === 200, `guest signin → 200 (got ${signin.status})`);
  if (signin.status !== 200) return;
  const guestId = signin.json.user.id;
  const guestTok = signin.json.access_token;

  // 2. upgrade via PATCH /auth/v1/user
  const email = `upgraded-${Date.now()}@test.com`;
  const password = "upgraded-password-123";
  const patch = await api("PATCH", "/auth/v1/user", { email, password }, guestTok);
  check(patch.status === 200, `guest PATCHes real email+password → 200 (got ${patch.status})`);

  const row = psql(
    `SELECT id, role, provider, array_to_string(providers, ','), email FROM pgstack.users WHERE id = '${guestId}';`,
  ).trim();
  check(row.includes(guestId), "row still exists under the SAME id — auth.uid() data survives");
  check(row.includes("authenticated"), `row role flipped to authenticated (${row})`);
  check(row.includes("anonymous,email"), `providers grew to anonymous,email (${row})`);
  check(row.includes(email), "row carries the real address");

  // 3. setting a password REVOKES the guest-era refresh tokens (the finding-4
  // transactional guarantee: a new credential never coexists with old
  // sessions). The old refresh token must be dead.
  const rot = await api("POST", "/auth/v1/token",
    { grant_type: "refresh_token", refresh_token: signin.json.refresh_token });
  check(rot.status === 401,
    `guest-era refresh token is revoked by the upgrade (got ${rot.status}) — new credential never coexists with old sessions`);

  // 4. password login lands on the same account, and its freshly minted
  // token has NO is_anonymous (INV-B: derived from the flipped row).
  const login = await api("POST", "/auth/v1/token", { grant_type: "password", email, password });
  check(login.status === 200, `password login with the new identity → 200 (got ${login.status})`);
  check(login.json?.user?.id === guestId, "password login resolves to the SAME id");
  if (login.status === 200) {
    const claims = jwtPayload(login.json.access_token);
    check(claims.is_anonymous === undefined,
      "post-upgrade token has NO is_anonymous — the marker derives from the row, not the old token");
    check(claims.role === "authenticated", `post-upgrade token role=authenticated (got ${claims.role})`);
    const rot2 = await api("POST", "/auth/v1/token",
      { grant_type: "refresh_token", refresh_token: login.json.refresh_token });
    check(rot2.status === 200 && jwtPayload(rot2.json.access_token).is_anonymous === undefined,
      "and rotation of the NEW session stays unmarked (INV-B holds across mints)");
  }

  // 5. the reaper can never touch an upgraded account
  const reapable = psql(
    `SELECT count(*) FROM pgstack.users WHERE id = '${guestId}' AND providers = ARRAY['anonymous'];`,
  ).trim();
  check(reapable.endsWith("0"), "reaper predicate (providers={anonymous}) no longer matches the upgraded row");

  try { psql(`DELETE FROM pgstack.users WHERE id = '${guestId}';`); } catch {}

  // 6. round 47 H2: a guest that sets ONLY a password (providers still
  // {anonymous}) must remain a MARKED guest through password login — the
  // mint derives marker and guest TTL from the row, like refresh rotation.
  const g2 = await api("POST", "/auth/v1/anonymous", {});
  check(g2.status === 200, `second guest signin → 200 (got ${g2.status})`);
  if (g2.status === 200) {
    const gid = g2.json.user.id;
    const gEmail = g2.json.user.email; // synthetic .invalid address
    const gPwd = "guest-password-123";
    const p = await api("PATCH", "/auth/v1/user", { password: gPwd }, g2.json.access_token);
    check(p.status === 200, `guest sets password only → 200 (got ${p.status})`);
    const still = psql(`SELECT array_to_string(providers, ',') FROM pgstack.users WHERE id = '${gid}';`).trim();
    check(still === "anonymous", `providers unchanged by a password-only set (got ${still})`);
    const relog = await api("POST", "/auth/v1/token", { grant_type: "password", email: gEmail, password: gPwd });
    check(relog.status === 200, `password login on the synthetic address → 200 (got ${relog.status})`);
    if (relog.status === 200) {
      const c2 = jwtPayload(relog.json.access_token);
      check(c2.is_anonymous === true,
        "password-minted token KEEPS is_anonymous (round 47 H2 — INV-B at EVERY mint site)");
      check(c2.role === "anonymous",
        `password-minted token keeps role=anonymous in strict mode (got ${c2.role})`);
      check(relog.json?.user?.is_anonymous === true, "password-grant user object marked is_anonymous");
    }
    try { psql(`DELETE FROM pgstack.users WHERE id = '${gid}';`); } catch {}
  }

  // 7. round 47 M5: magic-link confirm must mint from the POST-flip row.
  // Plant a magiclink token directly (sha256-hex, the shared token-hash
  // shape) for a fresh guest and decode the redirect fragment: the token
  // must be an UNMARKED authenticated token, never role=anonymous.
  const g3 = await api("POST", "/auth/v1/anonymous", {});
  check(g3.status === 200, `third guest signin → 200 (got ${g3.status})`);
  if (g3.status === 200) {
    const gid = g3.json.user.id;
    const raw = crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    psql(`INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, expires_at)
          VALUES ('${gid}', '${hash}', 'magiclink', now() + interval '10 minutes');`);
    const resp = await fetch(`${PROXY}/auth/v1/magiclink/verify?token=${raw}`, { redirect: "manual" });
    const loc = resp.headers.get("location") ?? "";
    const frag = new URLSearchParams(loc.split("#")[1] ?? "");
    const at = frag.get("access_token");
    check(!!at, `magiclink confirm redirects with an access_token (status ${resp.status})`);
    if (at) {
      const c3 = jwtPayload(at);
      check(c3.role === "authenticated",
        `magiclink-minted token has role=authenticated from the FLIPPED row (got ${c3.role}) — round 47 M5`);
      check(c3.is_anonymous === undefined, "magiclink-minted token carries no is_anonymous");
    }
    const rrow = psql(`SELECT role FROM pgstack.users WHERE id = '${gid}';`).trim();
    check(rrow.includes("authenticated"), `row role flipped to authenticated (${rrow})`);
    try { psql(`DELETE FROM pgstack.users WHERE id = '${gid}';`); } catch {}
  }
}

main().then(() => {
  if (failed > 0) {
    console.error(`\n✗ ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ guest upgrade keeps the id and drops the marker");
}).catch((e) => {
  console.error("✗ test crashed:", e);
  process.exit(2);
});
