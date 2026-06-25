/**
 * E2E test: Transaction batching (POST /rest/v1/batch).
 *
 * Requires: docker compose running with JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY.
 * Uses existing 'todos' table + 'authors'/'posts' tables from init.sql.
 */

const BASE = process.env.PROXY_URL || process.env.BASE_URL || 'http://127.0.0.1:8080';
const ANON = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const SRV = process.env.SERVICE_ROLE_KEY || 'dev-only-service-role-key-do-not-use-in-production';

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

async function batch(operations, options, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body = { operations, ...options };
  const res = await fetch(`${BASE}/rest/v1/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
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

// ---- Setup ----

async function setup() {
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);
}

// ---- Tests ----

async function testBasicBatch() {
  console.log('\nTest 1: Basic batch — insert + read');
  const r = await batch([
    { id: 'ins', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Batch test', done: false } },
    { id: 'read', method: 'GET', path: '/rest/v1/todos', query: 'title=eq.Batch test' },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.results?.length === 2, `2 results (got ${r.json.results?.length})`);
  assert(r.json.results[0].status === 201, `insert returns 201`);
  assert(r.json.results[1].status === 200, `select returns 200`);

  const readData = r.json.results[1].data;
  assert(Array.isArray(readData), 'read returns array');
  assert(readData.length >= 1, 'at least 1 row');
  assert(readData[0].title === 'Batch test', 'correct title');
}

async function testTemplateResolution() {
  console.log('\nTest 2: Template resolution — {{op.field}}');
  const r = await batch([
    { id: 'create', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Template parent', done: false } },
    { id: 'verify', method: 'GET', path: '/rest/v1/todos', query: 'id=eq.{{create.id}}&select=id,title' },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  const verifyData = r.json.results?.[1]?.data;
  assert(Array.isArray(verifyData) && verifyData.length === 1, 'template resolved — found 1 row');
  assert(verifyData?.[0]?.title === 'Template parent', 'correct row via template');
}

async function testAtomicRollback() {
  console.log('\nTest 3: Atomic mode — rollback on error');
  // Insert a valid row, then try to insert into a non-existent table
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  const r = await batch([
    { id: 'ok', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Should rollback', done: false } },
    { id: 'fail', method: 'POST', path: '/rest/v1/nonexistent_table', body: { x: 1 } },
  ], { atomic: true }, SRV);

  assert(r.status === 422, `atomic failure returns 422 (got ${r.status})`);
  assert(r.json.error?.includes('failed'), 'error message present');
  assert(r.json.failed_operation === 'fail', `failed_operation = fail`);

  // Verify the first insert was rolled back
  const check = await api('GET', '/rest/v1/todos?title=eq.Should rollback', null, SRV);
  assert(check.json.length === 0, 'first insert was rolled back');
}

async function testPartialMode() {
  console.log('\nTest 4: Partial mode — continue after error');
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  const r = await batch([
    { id: 'ok1', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Partial A', done: false } },
    { id: 'fail', method: 'POST', path: '/rest/v1/nonexistent_table', body: { x: 1 } },
    { id: 'ok2', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Partial B', done: true } },
  ], { atomic: false }, SRV);

  assert(r.status === 207, `partial failure returns 207 (got ${r.status})`);
  assert(r.json.results?.length === 3, '3 results returned');
  assert(r.json.results[0].status === 201, 'first op succeeded');
  assert(r.json.results[1].error !== undefined, 'second op has error');
  assert(r.json.results[2].status === 201, 'third op succeeded');

  // Verify both successful inserts persisted
  const check = await api('GET', '/rest/v1/todos?select=title&order=title.asc', null, SRV);
  const titles = check.json.map(r => r.title);
  assert(titles.includes('Partial A'), 'Partial A persisted');
  assert(titles.includes('Partial B'), 'Partial B persisted');
}

async function testBatchUpdate() {
  console.log('\nTest 5: Batch update with template');
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  const r = await batch([
    { id: 'ins', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Update me', done: false } },
    { id: 'upd', method: 'PATCH', path: '/rest/v1/todos', query: 'id=eq.{{ins.id}}', body: { done: true } },
    { id: 'check', method: 'GET', path: '/rest/v1/todos', query: 'id=eq.{{ins.id}}' },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  const checkData = r.json.results?.[2]?.data;
  assert(checkData?.[0]?.done === true, 'row updated via template');
}

async function testBatchDelete() {
  console.log('\nTest 6: Batch delete');
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  const r = await batch([
    { id: 'ins', method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Delete me', done: false } },
    { id: 'del', method: 'DELETE', path: '/rest/v1/todos', query: 'id=eq.{{ins.id}}' },
    { id: 'check', method: 'GET', path: '/rest/v1/todos', query: 'title=eq.Delete me' },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  const checkData = r.json.results?.[2]?.data;
  assert(checkData?.length === 0, 'row deleted');
}

async function testBatchRPC() {
  console.log('\nTest 7: Batch with RPC call');
  const r = await batch([
    { id: 'add', method: 'POST', path: '/rest/v1/rpc/add_numbers', body: { a: 10, b: 32 } },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  // RPC returns the result directly
  const data = r.json.results?.[0]?.data;
  assert(data === 42 || data === '42' || JSON.stringify(data) === '42', `RPC returned 42 (got ${JSON.stringify(data)})`);
}

async function testEmptyBatch() {
  console.log('\nTest 8: Empty batch rejected');
  const r = await batch([], {}, SRV);
  assert(r.status === 400, `empty batch returns 400 (got ${r.status})`);
}

async function testMaxOperations() {
  console.log('\nTest 9: Max operations limit');
  // Default is 20, create 21
  const ops = Array.from({ length: 21 }, (_, i) => ({
    id: `op${i}`,
    method: 'GET',
    path: '/rest/v1/todos',
    query: 'select=id&limit=1',
  }));
  const r = await batch(ops, {}, SRV);
  assert(r.status === 400, `too many ops returns 400 (got ${r.status})`);
  assert(r.json.error?.includes('too many'), 'error mentions too many operations');
}

async function testInvalidMethod() {
  console.log('\nTest 10: Invalid method rejected');
  const r = await batch([
    { id: 'bad', method: 'PUT', path: '/rest/v1/todos', body: {} },
  ], {}, SRV);
  assert(r.status === 400, `invalid method returns 400 (got ${r.status})`);
}

async function testAutoIds() {
  console.log('\nTest 11: Auto-generated operation IDs');
  const r = await batch([
    { method: 'POST', path: '/rest/v1/todos', body: { user_id: '00000000-0000-0000-0000-000000000001', title:'Auto ID', done: false } },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.results?.[0]?.id === 'op0', `auto ID = op0 (got ${r.json.results?.[0]?.id})`);
}

// round-45 F1 HIGH (SECURITY.md invariant 27): structural JSON injection via
// unescaped template substitution. op1 returns a title whose value contains
// `","done":true,"title":"`; op2 templates it into a JSON body that deliberately
// does NOT set `done`. Pre-fix the raw substitution forged a top-level `done`
// key (done=true) on op2's row; after the fix the value is JSON-escaped and the
// row keeps its `done` default (false).
async function testTemplateJSONInjection() {
  console.log('\nTest 12: Template JSON injection — escaped, no key smuggling');
  await api('DELETE', '/rest/v1/todos?id=gt.0', null, SRV);

  const payload = 'INJ","done":true,"title":"INJ';
  const r = await batch([
    { id: 'src', method: 'POST', path: '/rest/v1/todos',
      body: { user_id: '00000000-0000-0000-0000-000000000001', title: payload, done: false } },
    // op2 sets NO `done` — only an injected key could turn it true.
    { id: 'sink', method: 'POST', path: '/rest/v1/todos',
      body: { user_id: '00000000-0000-0000-0000-000000000002', title: '{{src.title}}' } },
  ], { atomic: true }, SRV);

  assert(r.status === 200, `status 200 (got ${r.status})`);
  const sink = r.json.results?.[1]?.data;
  const row = Array.isArray(sink) ? sink[0] : sink;
  assert(row?.done !== true, `op2 'done' was NOT injected (got ${row?.done})`);
  assert(row?.title === payload, `op2 title round-tripped as literal string`);
}

// ---- Runner ----

async function main() {
  console.log('E2E: Transaction Batching (POST /rest/v1/batch)\n');

  try {
    await setup();
    await testBasicBatch();
    await testTemplateResolution();
    await testAtomicRollback();
    await testPartialMode();
    await testBatchUpdate();
    await testBatchDelete();
    await testBatchRPC();
    await testEmptyBatch();
    await testMaxOperations();
    await testInvalidMethod();
    await testAutoIds();
    await testTemplateJSONInjection();
  } catch (e) {
    console.error('\nFATAL:', e);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
