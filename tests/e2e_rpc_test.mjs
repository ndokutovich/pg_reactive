/**
 * E2E test: RPC function calls (A6).
 *
 * Tests PostgreSQL function invocation via:
 *   POST /rest/v1/rpc/{function}   — with JSON body params
 *   GET  /rest/v1/rpc/{function}   — with query-string params
 *
 * Requires: docker compose running with:
 *   JWT_SECRET, SERVICE_ROLE_KEY (reads from env, defaults to docker-compose values)
 *
 * Functions created in setup (via /api/sql):
 *   public.rpc_add(a int, b int) RETURNS int
 *   public.rpc_greet(name text) RETURNS text
 *   public.rpc_no_params() RETURNS text
 *   public.rpc_list_nums(n int) RETURNS SETOF int
 *   public.rpc_record_fn() RETURNS TABLE(x int, label text)
 *
 * Run with: node tests/e2e_rpc_test.mjs
 */

const BASE = 'http://127.0.0.1:8080';
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

async function sql(query) {
  return api('POST', '/api/sql', { sql: query }, SRV);
}

// ---- Setup ----

async function setup() {
  console.log('Setting up RPC test functions...');

  // Scalar integer function: rpc_add(a int, b int) -> int
  await sql(`
    CREATE OR REPLACE FUNCTION public.rpc_add(a int, b int)
    RETURNS int
    LANGUAGE sql
    AS $$ SELECT a + b $$
  `);

  // Scalar text function: rpc_greet(name text) -> text
  await sql(`
    CREATE OR REPLACE FUNCTION public.rpc_greet(name text)
    RETURNS text
    LANGUAGE sql
    AS $$ SELECT 'Hello, ' || name || '!' $$
  `);

  // No-parameter function: rpc_no_params() -> text
  await sql(`
    CREATE OR REPLACE FUNCTION public.rpc_no_params()
    RETURNS text
    LANGUAGE sql
    AS $$ SELECT 'no params' $$
  `);

  // Set-returning function: rpc_list_nums(n int) -> SETOF int
  await sql(`
    CREATE OR REPLACE FUNCTION public.rpc_list_nums(n int)
    RETURNS SETOF int
    LANGUAGE sql
    AS $$ SELECT generate_series(1, n) $$
  `);

  // Table-returning function: rpc_record_fn() -> TABLE(x int, label text)
  await sql(`
    CREATE OR REPLACE FUNCTION public.rpc_record_fn()
    RETURNS TABLE(x int, label text)
    LANGUAGE sql
    AS $$
      SELECT 1, 'one'
      UNION ALL
      SELECT 2, 'two'
      UNION ALL
      SELECT 3, 'three'
    $$
  `);

  console.log('  RPC functions created.');
}

// ---- RPC Tests ----

async function testScalarInt() {
  console.log('\nTest R1: Scalar int function via POST (rpc_add)');

  const r = await api('POST', '/rest/v1/rpc/rpc_add', { a: 3, b: 7 }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  // Scalar functions: single-element array is unwrapped to bare value
  assert(r.json === 10, `3 + 7 = 10 (got ${JSON.stringify(r.json)})`);
}

async function testScalarText() {
  console.log('\nTest R2: Scalar text function via POST (rpc_greet)');

  const r = await api('POST', '/rest/v1/rpc/rpc_greet', { name: 'World' }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 'Hello, World!', `greeting (got ${JSON.stringify(r.json)})`);
}

async function testNoParams() {
  console.log('\nTest R3: No-parameter function (rpc_no_params)');

  // POST with empty body
  const r = await api('POST', '/rest/v1/rpc/rpc_no_params', {}, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 'no params', `result = 'no params' (got ${JSON.stringify(r.json)})`);
}

async function testSetReturning() {
  console.log('\nTest R4: Set-returning function (rpc_list_nums)');

  const r = await api('POST', '/rest/v1/rpc/rpc_list_nums', { n: 5 }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  // Set-returning functions always return an array
  assert(Array.isArray(r.json), `returns array (got ${typeof r.json})`);
  assert(r.json.length === 5, `5 rows (got ${r.json.length})`);
  // Each row is a single-column record: { rpc_list_nums: N } or unwrapped int
  const values = r.json.map(row =>
    typeof row === 'object' && row !== null ? Object.values(row)[0] : row
  );
  assert(values.includes(1), 'includes 1');
  assert(values.includes(5), 'includes 5');
}

async function testTableReturn() {
  console.log('\nTest R5: Table-returning function (rpc_record_fn)');

  const r = await api('POST', '/rest/v1/rpc/rpc_record_fn', {}, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), `returns array (got ${typeof r.json})`);
  assert(r.json.length === 3, `3 rows (got ${r.json.length})`);
  assert(r.json[0].x !== undefined, 'row has x field');
  assert(r.json[0].label !== undefined, 'row has label field');
  assert(r.json[0].x === 1 && r.json[0].label === 'one', `first row: x=1, label=one (got ${JSON.stringify(r.json[0])})`);
  assert(r.json[2].x === 3 && r.json[2].label === 'three', `last row: x=3, label=three (got ${JSON.stringify(r.json[2])})`);
}

async function testGetWithQueryParams() {
  console.log('\nTest R6: Function call via GET with query-string params (rpc_add)');

  const r = await api('GET', '/rest/v1/rpc/rpc_add?a=10&b=20', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 30, `10 + 20 = 30 (got ${JSON.stringify(r.json)})`);
}

async function testGetNoParams() {
  console.log('\nTest R7: No-parameter function via GET (rpc_no_params)');

  const r = await api('GET', '/rest/v1/rpc/rpc_no_params', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 'no params', `result (got ${JSON.stringify(r.json)})`);
}

async function testNonExistentFunction() {
  console.log('\nTest R8: Non-existent function returns error');

  const r = await api('POST', '/rest/v1/rpc/rpc_does_not_exist_xyz', {}, SRV);
  // PG returns an error (function not found -> 42883 undefined_function -> 400 BadRequest)
  assert(r.status === 400 || r.status === 404 || r.status === 500,
    `non-existent fn -> error status (got ${r.status})`);
  assert(r.json.error !== undefined, 'response has error field');
}

async function testInvalidFunctionName() {
  console.log('\nTest R9: Invalid function name (SQL injection attempt)');

  // Function names must match [a-zA-Z0-9_] and not start with digit
  // The proxy validates this and returns 400 before touching PG.
  // URL-encode the space so fetch does not reject the URL.
  const r = await api('POST', '/rest/v1/rpc/drop%20table', {}, SRV);
  assert(r.status === 400, `invalid fn name -> 400 (got ${r.status})`);
  assert(r.json.error !== undefined, 'response has error field');
}

async function testInvalidFunctionNameDash() {
  console.log('\nTest R10: Function name with dash is invalid');

  const r = await api('POST', '/rest/v1/rpc/my-function', {}, SRV);
  // Axum's path extractor will route "my-function" as a valid path segment,
  // but the proxy's is_valid_fn_name check rejects dashes -> 400.
  assert(r.status === 400, `dash in fn name -> 400 (got ${r.status})`);
}

async function testWrongParamType() {
  console.log('\nTest R11: Wrong parameter type causes database error');

  // rpc_add expects int but we send a non-numeric string
  const r = await api('POST', '/rest/v1/rpc/rpc_add', { a: 'not-a-number', b: 5 }, SRV);
  // PG cast failure: 22P02 invalid_text_representation -> 400 BadRequest from AppError
  assert(r.status === 400 || r.status === 500,
    `wrong param type -> error status (got ${r.status})`);
  assert(r.json.error !== undefined, 'response has error field');
}

async function testNoAuth() {
  console.log('\nTest R12: No auth header -> 401');

  const r = await api('POST', '/rest/v1/rpc/rpc_add', { a: 1, b: 2 });
  assert(r.status === 401, `no auth -> 401 (got ${r.status})`);
}

// ---- Teardown ----

async function teardown() {
  await sql('DROP FUNCTION IF EXISTS public.rpc_add(int, int)');
  await sql('DROP FUNCTION IF EXISTS public.rpc_greet(text)');
  await sql('DROP FUNCTION IF EXISTS public.rpc_no_params()');
  await sql('DROP FUNCTION IF EXISTS public.rpc_list_nums(int)');
  await sql('DROP FUNCTION IF EXISTS public.rpc_record_fn()');
  console.log('\nTeardown complete.');
}

// ---- Main ----

async function main() {
  console.log('=== RPC Function Call E2E Test ===');

  await setup();

  await testScalarInt();
  await testScalarText();
  await testNoParams();
  await testSetReturning();
  await testTableReturn();
  await testGetWithQueryParams();
  await testGetNoParams();
  await testNonExistentFunction();
  await testInvalidFunctionName();
  await testInvalidFunctionNameDash();
  await testWrongParamType();
  await testNoAuth();

  await teardown();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('RPC test error:', e);
  process.exit(1);
});
