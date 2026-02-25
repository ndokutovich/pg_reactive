/**
 * E2E test: RLS middleware — verifies that SET LOCAL role + claims
 * works correctly so RLS policies are enforced per-request.
 *
 * Requires:
 *   JWT_SECRET=test-secret-key
 *   ANON_KEY=anon-key-12345
 *   SERVICE_ROLE_KEY=srv-key-99999
 */

const BASE = 'http://127.0.0.1:8080';
const PG_URL = 'postgres://postgres:postgres@127.0.0.1:15432/pg_reactive_test';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${msg}`);
  passed++;
  return true;
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// ---- Tests ----

async function testRlsDebugAnon() {
  console.log('\nTest 1: RLS debug with anon key');
  const r = await api('GET', '/rest/v1/rls-debug', null, 'anon-key-12345');
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.pg_role === 'anon', `pg_role = anon (got ${r.json.pg_role})`);
  assert(r.json.request_sub === null, 'no sub for anon');
}

async function testRlsDebugServiceRole() {
  console.log('\nTest 2: RLS debug with service_role key');
  const r = await api('GET', '/rest/v1/rls-debug', null, 'srv-key-99999');
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.pg_role === 'service_role', `pg_role = service_role (got ${r.json.pg_role})`);
}

async function testRlsDebugJwt() {
  console.log('\nTest 3: RLS debug with JWT');

  // Signup to get a JWT
  const email = `rls-${Date.now()}@test.com`;
  const signup = await api('POST', '/auth/v1/signup', { email, password: 'test123456' });
  const token = signup.json.access_token;
  const userId = signup.json.user.id;

  const r = await api('GET', '/rest/v1/rls-debug', null, token);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.pg_role === 'authenticated', `pg_role = authenticated (got ${r.json.pg_role})`);
  assert(r.json.request_sub === userId, `sub matches user id`);
  assert(r.json.jwt_claims?.email === email, 'claims contain email');

  return { token, userId, email };
}

async function testRlsDebugNoAuth() {
  console.log('\nTest 4: RLS debug without auth');
  const r = await api('GET', '/rest/v1/rls-debug');
  assert(r.status === 401, `no auth -> 401 (got ${r.status})`);
}

async function testRlsDebugApiKeyHeader() {
  console.log('\nTest 5: RLS debug with apikey header');
  const headers = { 'Content-Type': 'application/json', 'apikey': 'anon-key-12345' };
  const res = await fetch(`${BASE}/rest/v1/rls-debug`, { headers });
  const json = await res.json();
  assert(res.status === 200, `apikey header -> 200 (got ${res.status})`);
  assert(json.pg_role === 'anon', `pg_role = anon via apikey (got ${json.pg_role})`);
}

async function testRlsIsolation() {
  console.log('\nTest 6: RLS context isolation between requests');

  // Two different users
  const email1 = `rls-iso1-${Date.now()}@test.com`;
  const email2 = `rls-iso2-${Date.now()}@test.com`;
  const signup1 = await api('POST', '/auth/v1/signup', { email: email1, password: 'test123456' });
  const signup2 = await api('POST', '/auth/v1/signup', { email: email2, password: 'test123456' });

  // Concurrent requests — each should see their own user
  const [r1, r2] = await Promise.all([
    api('GET', '/rest/v1/rls-debug', null, signup1.json.access_token),
    api('GET', '/rest/v1/rls-debug', null, signup2.json.access_token),
  ]);

  assert(r1.json.request_sub === signup1.json.user.id, `user1 sees own sub`);
  assert(r2.json.request_sub === signup2.json.user.id, `user2 sees own sub`);
  assert(r1.json.request_sub !== r2.json.request_sub, 'subs are different (no leaking)');
}

// ---- Main ----

async function main() {
  console.log('=== RLS Middleware E2E Test ===');

  await testRlsDebugAnon();
  await testRlsDebugServiceRole();
  const user = await testRlsDebugJwt();
  await testRlsDebugNoAuth();
  await testRlsDebugApiKeyHeader();
  await testRlsIsolation();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('RLS test error:', e);
  process.exit(1);
});
