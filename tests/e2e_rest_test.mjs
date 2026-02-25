/**
 * E2E test: REST API (PostgREST-compatible CRUD).
 *
 * Requires: docker compose running with:
 *   JWT_SECRET=test-secret-key
 *   ANON_KEY=anon-key-12345
 *   SERVICE_ROLE_KEY=srv-key-99999
 *
 * And a 'todos' table in public schema with: id serial, user_id uuid, title text, done boolean
 */

const BASE = 'http://127.0.0.1:8080';
const ANON = 'anon-key-12345';
const SRV = 'srv-key-99999';

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

// ---- Setup: clean table ----

async function setup() {
  // Delete all rows via service_role
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  // Insert test data
  await api('POST', '/rest/v1/todos', [
    { title: 'Buy milk', done: false },
    { title: 'Write code', done: true },
    { title: 'Deploy app', done: false },
  ], SRV);
}

// ---- Tests ----

async function testSelectAll() {
  console.log('\nTest 1: SELECT all');
  const r = await api('GET', '/rest/v1/todos', null, ANON);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array');
  assert(r.json.length === 3, `3 rows (got ${r.json.length})`);
}

async function testSelectFilter() {
  console.log('\nTest 2: SELECT with filter');
  const r = await api('GET', '/rest/v1/todos?done=eq.false', null, ANON);
  assert(r.status === 200, `status 200`);
  assert(r.json.length === 2, `2 undone rows (got ${r.json.length})`);
  assert(r.json.every(row => row.done === false), 'all rows have done=false');
}

async function testSelectColumns() {
  console.log('\nTest 3: SELECT specific columns');
  const r = await api('GET', '/rest/v1/todos?select=id,title', null, ANON);
  assert(r.status === 200, `status 200`);
  assert(r.json[0].id !== undefined, 'has id');
  assert(r.json[0].title !== undefined, 'has title');
  assert(r.json[0].done === undefined, 'no done column');
}

async function testSelectOrder() {
  console.log('\nTest 4: SELECT with order');
  const r = await api('GET', '/rest/v1/todos?order=title.asc', null, ANON);
  assert(r.status === 200, `status 200`);
  const titles = r.json.map(r => r.title);
  const sorted = [...titles].sort();
  assert(JSON.stringify(titles) === JSON.stringify(sorted), `ordered alphabetically`);
}

async function testSelectLimit() {
  console.log('\nTest 5: SELECT with limit and offset');
  const r = await api('GET', '/rest/v1/todos?order=id.asc&limit=2', null, ANON);
  assert(r.status === 200, `status 200`);
  assert(r.json.length === 2, `2 rows with limit (got ${r.json.length})`);

  const r2 = await api('GET', '/rest/v1/todos?order=id.asc&limit=2&offset=2', null, ANON);
  assert(r2.json.length === 1, `1 row with offset (got ${r2.json.length})`);
}

async function testSelectNot() {
  console.log('\nTest 6: SELECT with NOT filter');
  const r = await api('GET', '/rest/v1/todos?done=not.eq.true', null, ANON);
  assert(r.status === 200, `status 200`);
  assert(r.json.length === 2, `2 rows not done (got ${r.json.length})`);
}

async function testInsertSingle() {
  console.log('\nTest 7: INSERT single');
  const r = await api('POST', '/rest/v1/todos', { title: 'New todo', done: false }, SRV);
  assert(r.status === 201, `status 201 (got ${r.status})`);
  assert(r.json.title === 'New todo', 'returned title');
  assert(r.json.id > 0, 'has auto-generated id');
  return r.json.id;
}

async function testInsertBulk() {
  console.log('\nTest 8: INSERT bulk');
  const r = await api('POST', '/rest/v1/todos', [
    { title: 'Bulk 1', done: false },
    { title: 'Bulk 2', done: true },
  ], SRV);
  assert(r.status === 201, `status 201 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array for bulk');
  assert(r.json.length === 2, `2 rows inserted (got ${r.json.length})`);
}

async function testUpdate(insertedId) {
  console.log('\nTest 9: UPDATE');
  const r = await api('PATCH', `/rest/v1/todos?id=eq.${insertedId}`, { done: true }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 1, '1 row updated');
  assert(r.json[0].done === true, 'done set to true');
}

async function testUpdateNoFilter() {
  console.log('\nTest 10: UPDATE without filter -> 400');
  const r = await api('PATCH', '/rest/v1/todos', { done: true }, SRV);
  assert(r.status === 400, `no-filter update -> 400 (got ${r.status})`);
}

async function testDelete(insertedId) {
  console.log('\nTest 11: DELETE');
  const r = await api('DELETE', `/rest/v1/todos?id=eq.${insertedId}`, null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 1, '1 row deleted');
}

async function testDeleteNoFilter() {
  console.log('\nTest 12: DELETE without filter -> 400');
  const r = await api('DELETE', '/rest/v1/todos', null, SRV);
  assert(r.status === 400, `no-filter delete -> 400 (got ${r.status})`);
}

async function testNotFound() {
  console.log('\nTest 13: Table not found');
  const r = await api('GET', '/rest/v1/nonexistent', null, ANON);
  assert(r.status === 404, `nonexistent table -> 404 (got ${r.status})`);
}

async function testBadFilter() {
  console.log('\nTest 14: Bad filter operator');
  const r = await api('GET', '/rest/v1/todos?id=badop.5', null, ANON);
  assert(r.status === 400, `bad operator -> 400 (got ${r.status})`);
}

async function testBadColumn() {
  console.log('\nTest 15: Unknown column in filter');
  const r = await api('GET', '/rest/v1/todos?nonexistent=eq.5', null, ANON);
  assert(r.status === 400, `unknown column -> 400 (got ${r.status})`);
}

async function testNoAuth() {
  console.log('\nTest 16: No auth -> 401');
  const r = await api('GET', '/rest/v1/todos');
  assert(r.status === 401, `no auth -> 401 (got ${r.status})`);
}

// ---- Main ----

async function main() {
  console.log('=== REST API E2E Test ===');

  await setup();

  await testSelectAll();
  await testSelectFilter();
  await testSelectColumns();
  await testSelectOrder();
  await testSelectLimit();
  await testSelectNot();

  const insertedId = await testInsertSingle();
  await testInsertBulk();
  await testUpdate(insertedId);
  await testUpdateNoFilter();
  await testDelete(insertedId);
  await testDeleteNoFilter();

  await testNotFound();
  await testBadFilter();
  await testBadColumn();
  await testNoAuth();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('REST test error:', e);
  process.exit(1);
});
