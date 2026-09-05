#!/usr/bin/env node
// SECURITY.md — anonymous identity (0.3.0), INV-A + INV-B, network-visible.
//
// Guests from /auth/v1/anonymous are a FOURTH principal: PG role `anonymous`
// (strict default), a real pgstack.users row, is_anonymous:true in the JWT.
// The trust ordering is anon ⊆ anonymous ⊂ authenticated. This test proves,
// over HTTP against the running proxy:
//
//   gate OFF (ALLOW_ANONYMOUS_SIGNIN unset/false):
//     0. default-deny — POST /auth/v1/anonymous → 503, and no row appears.
//
//   gate ON:
//     1. signin → 200 with a refresh token; the JWT decodes to role=anonymous
//        (strict) and carries is_anonymous:true.
//     2. own identity: GET /auth/v1/user with the guest token → 200, same id.
//     3. INV-A isolation: a members-only table (policy + grant TO
//        authenticated ONLY) refuses the guest — and accepts a real
//        signed-up user, so the refusal is the policy, not a broken fixture.
//     4. INV-A floor: the public blog table (readable TO anon) is readable
//        by the guest too — guest ≥ visitor.
//     5. INV-B rotation: refreshing the guest session returns a token that
//        still carries is_anonymous:true.
//
// The gate mode is read from this test's own env (CI brings the stack up with
// ALLOW_ANONYMOUS_SIGNIN=true), mirroring ws__anon_refused_when_required.

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

// The REST catalog is loaded at proxy boot; a table created mid-test needs an
// explicit refresh (service_role-gated endpoint) before /rest/v1 can see it.
async function refreshCatalog() {
  const key = process.env.SERVICE_ROLE_KEY ?? "dev-only-service-role-key-do-not-use-in-production";
  const r = await fetch(`${PROXY}/api/catalog/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.status !== 200) throw new Error(`catalog refresh failed: ${r.status}`);
}

function setupMembersOnly() {
  // A table that is deliberately members-only: policy AND grant name
  // authenticated alone. lint:allow because being guest-INVISIBLE is the
  // entire point of the fixture.
  psql(`
    DROP TABLE IF EXISTS members_only CASCADE;
    CREATE TABLE members_only (id int PRIMARY KEY, note text);
    INSERT INTO members_only VALUES (1, 'for members eyes only');
    ALTER TABLE members_only ENABLE ROW LEVEL SECURITY;
    CREATE POLICY members_only_read ON members_only FOR SELECT TO authenticated USING (true); -- lint:allow=SEC-R31
    GRANT SELECT ON members_only TO authenticated; -- lint:allow=SEC-R31
  `);
}
function teardownMembersOnly() {
  try { psql("DROP TABLE IF EXISTS members_only CASCADE;"); } catch {}
}

async function main() {
  if (!GATE_ON) {
    const before = psql("SELECT count(*) FROM pgstack.users WHERE provider = 'anonymous';").trim();
    const r = await api("POST", "/auth/v1/anonymous", {});
    check(r.status === 503, `gate off: anonymous signin refused with 503 (got ${r.status})`);
    const after = psql("SELECT count(*) FROM pgstack.users WHERE provider = 'anonymous';").trim();
    check(before === after, "gate off: no guest row was created");
    return;
  }

  // 1. signin
  const signin = await api("POST", "/auth/v1/anonymous", {});
  check(signin.status === 200, `guest signin → 200 (got ${signin.status})`);
  if (signin.status !== 200) return;
  const { access_token, refresh_token, user } = signin.json;
  check(!!refresh_token, "guest received a refresh token");
  const claims = jwtPayload(access_token);
  check(claims.is_anonymous === true, "JWT carries is_anonymous:true");
  check(claims.role === "anonymous",
    `strict mode: JWT role is anonymous (got ${claims.role}) — TO authenticated policies must not match guests`);
  check(user?.is_anonymous === true, "user object marked is_anonymous");

  // 2. own identity
  const me = await api("GET", "/auth/v1/user", null, access_token);
  check(me.status === 200 && me.json?.id === user.id,
    `guest can read its own identity (GET /auth/v1/user → ${me.status})`);
  // round 47 L7: the marker must be on the user OBJECT too, on both proxies —
  // the SDK replaces its session user from this very response.
  check(me.json?.is_anonymous === true,
    "GET /auth/v1/user carries is_anonymous:true (round 47 L7)");

  // 2c. round 47 H1: storage's authenticated-only gates refuse the guest.
  // The trust matrix denies `anonymous` uploads and private listing; before
  // round 47 the gates tested only role==="anon" and strict guests slid by.
  const svcKey = process.env.SERVICE_ROLE_KEY ?? "dev-only-service-role-key-do-not-use-in-production";
  const bname = `r47priv${Date.now()}`;
  const mkb = await fetch(`${PROXY}/storage/v1/bucket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${svcKey}` },
    body: JSON.stringify({ name: bname, public: false }),
  });
  if (mkb.status >= 200 && mkb.status < 300) {
    const fd = new FormData();
    fd.append("file", new Blob(["guest-bytes"]), "guest.txt");
    const up = await fetch(`${PROXY}/storage/v1/object/${bname}/guest.txt`, {
      method: "POST", headers: { Authorization: `Bearer ${access_token}` }, body: fd,
    });
    check(up.status === 403, `guest upload refused with 403 (got ${up.status}) — round 47 H1`);
    const ls = await api("GET", `/storage/v1/object/list/${bname}`, null, access_token);
    check(ls.status === 403, `guest private-bucket list refused with 403 (got ${ls.status}) — round 47 H1`);
    try { await fetch(`${PROXY}/storage/v1/bucket/${bname}`, { method: "DELETE", headers: { Authorization: `Bearer ${svcKey}` } }); } catch {}
  } else {
    bad(`storage fixture: private bucket create failed (${mkb.status}) — H1 gate unproven`);
  }

  // 3. INV-A: members-only refuses the guest, accepts a member
  setupMembersOnly();
  await refreshCatalog();
  try {
    const guestRead = await api("GET", "/rest/v1/members_only?select=*", null, access_token);
    check(guestRead.status >= 400 || (Array.isArray(guestRead.json) && guestRead.json.length === 0 && guestRead.status !== 200),
      `TO authenticated table refuses the guest (got ${guestRead.status})`);
    check(guestRead.status !== 200,
      "guest is refused at the grant (403/401), not silently empty");

    const email = `inv-a-${Date.now()}@test.com`;
    const su = await api("POST", "/auth/v1/signup", { email, password: "password-123456" });
    const memberTok = su.json?.access_token;
    if (memberTok) {
      const memberRead = await api("GET", "/rest/v1/members_only?select=*", null, memberTok);
      check(memberRead.status === 200 && Array.isArray(memberRead.json) && memberRead.json.length === 1,
        `positive control: a signed-up member reads the same table (got ${memberRead.status})`);
    } else {
      bad(`positive control failed: signup → ${su.status} ${JSON.stringify(su.json).slice(0, 120)}`);
    }
  } finally {
    teardownMembersOnly();
    try { await refreshCatalog(); } catch {}
  }

  // 4. INV-A floor: public blog readable by the guest (guest ≥ visitor)
  const blog = await api("GET", "/rest/v1/authors?select=*", null, access_token);
  check(blog.status === 200, `guest reads the public blog table (got ${blog.status}) — guest ≥ visitor`);

  // 5. INV-B: rotation keeps the marker
  const rot = await api("POST", "/auth/v1/token", { grant_type: "refresh_token", refresh_token });
  check(rot.status === 200, `guest refresh → 200 (got ${rot.status})`);
  if (rot.status === 200) {
    const rotClaims = jwtPayload(rot.json.access_token);
    check(rotClaims.is_anonymous === true, "rotated token still carries is_anonymous (INV-B)");
    check(rotClaims.role === "anonymous", "rotated token keeps role=anonymous");
  }

  // cleanup the guest row
  try { psql(`DELETE FROM pgstack.users WHERE id = '${user.id}';`); } catch {}
}

main().then(() => {
  if (failed > 0) {
    console.error(`\n✗ ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ anonymous role isolation holds");
}).catch((e) => {
  console.error("✗ test crashed:", e);
  process.exit(2);
});
