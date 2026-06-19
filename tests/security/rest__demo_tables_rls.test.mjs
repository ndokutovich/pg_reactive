#!/usr/bin/env node
// SECURITY.md invariant #26 — the shipped demo schema is production-ready:
// every public-schema table that is network-reachable has RLS enabled, and no
// demo table grants write (or anon read of private data) to a network client.
//
// Demo-schema hardening: `todos` is per-user RLS (owner-scoped, authenticated
// only — anon has no grant); `authors`/`posts`/`comments` are public-READ with
// writes locked to service_role. Before this, the four demo tables granted full
// SELECT/INSERT/UPDATE/DELETE to anon with NO RLS, so any unauthenticated
// visitor could read, overwrite, and DELETE every row (vandalism + a template
// that taught the anti-pattern). docker/init.sql is the source of truth.
//
// This test proves, network-visibly:
//   1. per-user isolation: user B never sees user A's todos (RLS SELECT)
//   2. cross-user write is a no-op: B cannot UPDATE A's row (RLS UPDATE)
//   3. anon is denied the per-user table entirely (no grant -> 403)
//   4. blog is public-READ for anon (200) but anon writes are denied (no grant)

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const ANON = process.env.ANON_KEY ?? "dev-only-anon-key-do-not-use-in-production";

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

async function signup() {
  const email = `rls-demo-${Date.now()}-${Math.floor(performance.now())}@test.com`;
  const r = await api("POST", "/auth/v1/signup", { email, password: "test123456" });
  if (!r.json || !r.json.access_token) {
    throw new Error(`signup failed (status ${r.status}): ${JSON.stringify(r.json)}`);
  }
  return r.json.access_token;
}

async function main() {
  const a = await signup();
  const b = await signup();

  // 1. A inserts a todo (user_id defaults to A's auth.uid()); A sees it.
  const ins = await api("POST", "/rest/v1/todos", { title: "A private todo", done: false }, a);
  check(ins.status === 201, `A inserts own todo -> 201 (got ${ins.status})`);
  const aId = Array.isArray(ins.json) ? ins.json[0]?.id : ins.json?.id;
  check(typeof aId === "number", `A todo has an id (got ${aId})`);

  const aRead = await api("GET", "/rest/v1/todos", null, a);
  check(aRead.status === 200 && Array.isArray(aRead.json) && aRead.json.some((t) => t.id === aId),
    "A sees own todo");

  // 2. B must NOT see A's todo (RLS SELECT owner-scope).
  const bRead = await api("GET", "/rest/v1/todos", null, b);
  check(bRead.status === 200 && Array.isArray(bRead.json) && !bRead.json.some((t) => t.id === aId),
    "B does NOT see A's todo (per-user isolation)");

  // 3. B cannot UPDATE A's row — RLS USING hides it, so 0 rows change.
  const bUpd = await api("PATCH", `/rest/v1/todos?id=eq.${aId}`, { done: true }, b);
  check(bUpd.status === 200 && Array.isArray(bUpd.json) && bUpd.json.length === 0,
    `B's UPDATE of A's row affects 0 rows (got ${JSON.stringify(bUpd.json)})`);
  const verify = await api("GET", `/rest/v1/todos?id=eq.${aId}`, null, a);
  check(verify.json?.[0]?.done === false, "A's row is unchanged after B's write attempt");

  // 4. anon is denied the per-user table entirely (no grant -> 403).
  const anonTodos = await api("GET", "/rest/v1/todos", null, ANON);
  check(anonTodos.status === 403, `anon read of todos -> 403 (got ${anonTodos.status})`);

  // 5. blog is public-READ for anon...
  const anonAuthors = await api("GET", "/rest/v1/authors", null, ANON);
  check(anonAuthors.status === 200 && Array.isArray(anonAuthors.json),
    `anon read of public blog -> 200 (got ${anonAuthors.status})`);

  // ...but anon writes to blog are denied (no INSERT grant).
  const anonWrite = await api("POST", "/rest/v1/authors", { name: "evil" }, ANON);
  check(anonWrite.status === 401 || anonWrite.status === 403,
    `anon write to public blog -> 401/403 (got ${anonWrite.status})`);

  if (failed) {
    console.error(`\nFAIL: ${failed} demo-schema RLS assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS: demo schema is production-ready (per-user RLS + public-read locked writes).");
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
