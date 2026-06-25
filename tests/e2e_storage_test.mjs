/**
 * E2E test: Supabase-compatible Storage (buckets + objects).
 *
 * Parameterized on PROXY_URL (default http://127.0.0.1:8080). Run against the Go
 * reference (:8080) and the Rust port (:8081) — assertions are identical, so the
 * two MUST agree. Exercises the security-relevant surface from SECURITY.md's
 * storage rows + the Go reference proxy-go/routes/storage.go:
 *   - bucket create/delete require service_role;
 *   - anon may NOT upload (public bucket = anon READ, not anon WRITE) — audit F4;
 *   - owner-lock: a different user cannot overwrite an object (audit F1) — 403;
 *   - private bucket: anon download denied, owner download OK;
 *   - public bucket: anon download OK;
 *   - oversize upload (> bucket file_size_limit) → 413;
 *   - list / delete / round-trip byte-identity.
 *
 * Requires docker compose running with JWT auth enabled (dev defaults).
 */

const BASE = process.env.PROXY_URL || 'http://127.0.0.1:8080';
const SERVICE_KEY =
  process.env.SERVICE_ROLE_KEY || 'dev-only-service-role-key-do-not-use-in-production';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function rnd() {
  return Math.random().toString(36).slice(2, 10);
}

async function signup() {
  const email = `storage_${rnd()}@example.com`;
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password12345' }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`signup failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

function svc(headers = {}) {
  return { Authorization: `Bearer ${SERVICE_KEY}`, ...headers };
}
function jwt(token, headers = {}) {
  return { Authorization: `Bearer ${token}`, ...headers };
}
function anon(headers = {}) {
  return { apikey: ANON_KEY, ...headers };
}

async function uploadFile(bucket, name, content, token, mime = 'text/plain') {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: mime }), name.split('/').pop());
  return fetch(`${BASE}/storage/v1/object/${bucket}/${name}`, {
    method: 'POST',
    headers: token === 'anon' ? anon() : jwt(token),
    body: fd,
  });
}

async function run() {
  console.log(`\n=== Storage E2E against ${BASE} ===`);
  const tokenA = await signup();
  const tokenB = await signup();
  const priv = `priv${rnd()}`;
  const pub = `pub${rnd()}`;
  const small = `small${rnd()}`;

  // 1. Bucket admin requires service_role.
  console.log('Test: bucket create requires service_role');
  let r = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: jwt(tokenA, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: `nope${rnd()}` }),
  });
  assert(r.status === 403, `non-service_role create bucket -> 403 (got ${r.status})`);

  // 2. Create private + public + small-limit buckets as service_role.
  console.log('Test: create buckets (service_role)');
  r = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: svc({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: priv, public: false }),
  });
  assert(r.status === 201, `create private bucket -> 201 (got ${r.status})`);

  r = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: svc({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: pub, public: true }),
  });
  assert(r.status === 201, `create public bucket -> 201 (got ${r.status})`);

  r = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: svc({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: small, public: false, file_size_limit: 1000 }),
  });
  assert(r.status === 201, `create small-limit bucket -> 201 (got ${r.status})`);

  // Invalid bucket id rejected.
  r = await fetch(`${BASE}/storage/v1/bucket`, {
    method: 'POST',
    headers: svc({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'Bad.Name' }),
  });
  assert(r.status === 400, `invalid bucket id -> 400 (got ${r.status})`);

  // 3. List buckets includes ours.
  r = await fetch(`${BASE}/storage/v1/bucket`, { headers: jwt(tokenA) });
  const buckets = await r.json();
  assert(
    r.status === 200 && Array.isArray(buckets) && buckets.some((b) => b.id === priv),
    'list buckets includes the private bucket',
  );

  // 4. anon cannot upload to a PUBLIC bucket (public = read, not write).
  console.log('Test: anon upload refused (public bucket)');
  r = await uploadFile(pub, 'anon.txt', 'x', 'anon');
  assert(r.status === 403, `anon upload to public bucket -> 403 (got ${r.status})`);

  // 5. userA uploads to private bucket + round-trips byte-identical.
  console.log('Test: upload + download round-trip (private, owner)');
  const content = `hello-storage-${rnd()}\nsecond line`;
  r = await uploadFile(priv, 'docs/note.txt', content, tokenA);
  const up = await r.json();
  assert(r.status === 200 && up.id && up.key === `${priv}/docs/note.txt`, `upload -> 200 {id,key} (got ${r.status})`);

  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, { headers: jwt(tokenA) });
  const dl = await r.text();
  assert(r.status === 200 && dl === content, 'owner download bytes identical');
  assert((r.headers.get('content-type') || '').includes('text/plain'), 'download content-type text/plain');
  assert((r.headers.get('content-disposition') || '').includes('note.txt'), 'content-disposition has filename');
  assert((r.headers.get('cache-control') || '').includes('private'), 'private bucket -> Cache-Control private');

  // 6. Owner-lock: userB cannot overwrite userA's object.
  console.log('Test: owner-lock (different user overwrite refused)');
  r = await uploadFile(priv, 'docs/note.txt', 'evil overwrite', tokenB);
  assert(r.status === 403, `userB overwrite of userA object -> 403 (got ${r.status})`);
  // Confirm content unchanged.
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, { headers: jwt(tokenA) });
  assert((await r.text()) === content, 'object content unchanged after refused overwrite');

  // 7. Private bucket: anon download denied; userB (non-owner) denied.
  console.log('Test: private bucket access control');
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, { headers: anon() });
  assert(r.status === 403, `anon download from private bucket -> 403 (got ${r.status})`);
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, { headers: jwt(tokenB) });
  assert(r.status === 403, `non-owner download from private bucket -> 403 (got ${r.status})`);

  // 8. Public bucket: userA uploads, anon downloads OK.
  console.log('Test: public bucket anonymous read');
  const pubContent = `public-${rnd()}`;
  r = await uploadFile(pub, 'logo.txt', pubContent, tokenA);
  assert(r.status === 200, `upload to public bucket (authed) -> 200 (got ${r.status})`);
  r = await fetch(`${BASE}/storage/v1/object/${pub}/logo.txt`, { headers: anon() });
  assert(r.status === 200 && (await r.text()) === pubContent, 'anon download from public bucket OK + identical');

  // 8b. Stored-XSS hardening (round 46 / SECURITY.md invariant 28): an uploaded
  // text/html (or SVG-with-script) object is untrusted content served inline
  // from the proxy origin. The download MUST carry X-Content-Type-Options:
  // nosniff AND a Content-Security-Policy containing `sandbox`, neutralising
  // same-origin script execution. Worst case = a PUBLIC bucket (anon-readable).
  console.log('Test: stored-XSS download headers (nosniff + CSP sandbox)');
  r = await uploadFile(pub, 'evil.html', '<script>alert(1)</script>', tokenA, 'text/html');
  assert(r.status === 200, `upload text/html to public bucket -> 200 (got ${r.status})`);
  r = await fetch(`${BASE}/storage/v1/object/${pub}/evil.html`, { headers: anon() });
  assert(r.status === 200, `anon download of html object -> 200 (got ${r.status})`);
  assert(
    (r.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
    `download carries X-Content-Type-Options: nosniff (got '${r.headers.get('x-content-type-options')}')`,
  );
  assert(
    (r.headers.get('content-security-policy') || '').toLowerCase().includes('sandbox'),
    `download carries Content-Security-Policy with sandbox (got '${r.headers.get('content-security-policy')}')`,
  );

  // 9. List objects (owner sees own object in private bucket).
  console.log('Test: list objects');
  r = await fetch(`${BASE}/storage/v1/object/list/${priv}`, { headers: jwt(tokenA) });
  const objs = await r.json();
  assert(
    r.status === 200 && Array.isArray(objs) && objs.some((o) => o.name === 'docs/note.txt'),
    'owner list includes own object',
  );
  // prefix filter
  r = await fetch(`${BASE}/storage/v1/object/list/${priv}?prefix=docs/`, { headers: jwt(tokenA) });
  const prefObjs = await r.json();
  assert(
    r.status === 200 && prefObjs.every((o) => o.name.startsWith('docs/')),
    'prefix filter restricts to matching names',
  );

  // 10. Oversize upload -> 413 (file 1500B > bucket limit 1000B).
  console.log('Test: oversize upload -> 413');
  r = await uploadFile(small, 'big.bin', 'A'.repeat(1500), tokenA);
  assert(r.status === 413, `oversize upload (1500B > 1000B limit) -> 413 (got ${r.status})`);

  // 11. Delete: non-owner refused, owner OK, then 404.
  console.log('Test: delete object');
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, {
    method: 'DELETE',
    headers: jwt(tokenB),
  });
  assert(r.status === 404, `non-owner delete -> 404 (not found/access denied) (got ${r.status})`);
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, {
    method: 'DELETE',
    headers: jwt(tokenA),
  });
  assert(r.status === 200, `owner delete -> 200 (got ${r.status})`);
  r = await fetch(`${BASE}/storage/v1/object/${priv}/docs/note.txt`, { headers: jwt(tokenA) });
  assert(r.status === 404, `download after delete -> 404 (got ${r.status})`);

  // 12. Bucket delete requires service_role; cleanup.
  console.log('Test: bucket delete requires service_role + cleanup');
  r = await fetch(`${BASE}/storage/v1/bucket/${priv}`, { method: 'DELETE', headers: jwt(tokenA) });
  assert(r.status === 403, `non-service bucket delete -> 403 (got ${r.status})`);
  for (const b of [priv, pub, small]) {
    r = await fetch(`${BASE}/storage/v1/bucket/${b}`, { method: 'DELETE', headers: svc() });
    assert(r.status === 200, `service_role delete bucket ${b} -> 200 (got ${r.status})`);
  }

  console.log(`\n=== ${BASE}: ${passed} passed, ${failed} failed ===`);
  return failed === 0;
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
