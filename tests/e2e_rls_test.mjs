/**
 * E2E test: RLS middleware — verifies that SET LOCAL role + claims
 * works correctly so RLS policies are enforced per-request.
 *
 * Requires:
 *   JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY (reads from env, defaults to docker-compose values)
 */

const BASE = 'http://127.0.0.1:8080';
const ANON = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const SRV = process.env.SERVICE_ROLE_KEY || 'dev-only-service-role-key-do-not-use-in-production';
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
  console.log('\nTest 1: RLS debug with anon key (restricted to service_role)');
  const r = await api('GET', '/rest/v1/rls-debug', null, ANON);
  assert(r.status === 403, `anon -> 403 Forbidden (got ${r.status})`);
}

async function testRlsDebugServiceRole() {
  console.log('\nTest 2: RLS debug with service_role key');
  const r = await api('GET', '/rest/v1/rls-debug', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.pg_role === 'service_role', `pg_role = service_role (got ${r.json.pg_role})`);
}

async function testRlsDebugJwt() {
  console.log('\nTest 3: RLS debug with JWT (restricted to service_role)');

  // Signup to get a JWT
  const email = `rls-${Date.now()}@test.com`;
  const signup = await api('POST', '/auth/v1/signup', { email, password: 'test123456' });
  const token = signup.json.access_token;

  const r = await api('GET', '/rest/v1/rls-debug', null, token);
  assert(r.status === 403, `authenticated JWT -> 403 Forbidden (got ${r.status})`);

  return { token, userId: signup.json.user.id, email };
}

async function testRlsDebugNoAuth() {
  console.log('\nTest 4: RLS debug without auth');
  const r = await api('GET', '/rest/v1/rls-debug');
  assert(r.status === 401, `no auth -> 401 (got ${r.status})`);
}

async function testRlsDebugApiKeyHeader() {
  console.log('\nTest 5: RLS debug with apikey header (restricted to service_role)');
  const headers = { 'Content-Type': 'application/json', 'apikey': ANON };
  const res = await fetch(`${BASE}/rest/v1/rls-debug`, { headers });
  assert(res.status === 403, `apikey (anon) -> 403 Forbidden (got ${res.status})`);
}

async function testRlsIsolation() {
  console.log('\nTest 6: RLS context isolation via service_role debug endpoint');

  // Verify service_role can access rls-debug and sees correct role
  const r = await api('GET', '/rest/v1/rls-debug', null, SRV);
  assert(r.status === 200, `service_role -> 200 (got ${r.status})`);
  assert(r.json.pg_role === 'service_role', `pg_role = service_role (got ${r.json.pg_role})`);

  // Verify two concurrent service_role requests both succeed and see correct role
  const [r1, r2] = await Promise.all([
    api('GET', '/rest/v1/rls-debug', null, SRV),
    api('GET', '/rest/v1/rls-debug', null, SRV),
  ]);

  assert(r1.status === 200, `concurrent req 1 -> 200 (got ${r1.status})`);
  assert(r2.status === 200, `concurrent req 2 -> 200 (got ${r2.status})`);
  assert(r1.json.pg_role === 'service_role', `req 1 pg_role = service_role`);
  assert(r2.json.pg_role === 'service_role', `req 2 pg_role = service_role`);
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
