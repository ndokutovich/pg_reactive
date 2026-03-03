/**
 * E2E test: shopping_items PATCH (toggle checked) should return 200.
 *
 * Bug report: PATCH /rest/v1/shopping_items?id=eq.N returns 500 when a
 * logged-in user tries to toggle the 'checked' field of an item in their list.
 *
 * Reproduces the bug by:
 *   1. Signing up a fresh test user
 *   2. Creating a shopping list via RPC
 *   3. Inserting a shopping item
 *   4. PATCHing the item to set checked = true  ← this should return 200
 *   5. PATCHing it back to false                ← and this too
 *
 * Usage:
 *   node tests/e2e_shopping_patch_test.mjs
 *   BASE=http://127.0.0.1:8080 node tests/e2e_shopping_patch_test.mjs
 */

import { randomUUID } from 'crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

let passed = 0;
let failed = 0;

function ok(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, msg) { console.error(`  ✗ ${label}: ${msg}`); failed++; }

// ── helpers ──────────────────────────────────────────────────────────────────

async function request(method, path, body, token) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ANON_KEY,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

// ── test steps ────────────────────────────────────────────────────────────────

const email = `shopping-test-${randomUUID().slice(0, 8)}@example.com`;
const password = 'TestPass123!';
let token = null;
let listId = null;
let itemId = null;

console.log(`\nE2E: shopping_items PATCH bug regression\n`);
console.log(`  Target: ${BASE}`);
console.log(`  User:   ${email}\n`);

// 1. Signup
{
  const { status, data } = await request('POST', '/auth/v1/signup', { email, password });
  if (status === 200 || status === 201) {
    token = data.access_token;
    ok(`signup → ${status}`);
  } else {
    fail('signup', `expected 200/201, got ${status}: ${JSON.stringify(data)}`);
    process.exit(1); // Cannot continue without auth
  }
}

// 2. Create shopping list via RPC (SECURITY DEFINER function)
{
  const { status, data } = await request('POST', '/rest/v1/rpc/create_shopping_list', { list_name: 'Test List' }, token);
  if (status === 200 || status === 201) {
    listId = data?.id ?? data?.[0]?.id;
    ok(`create_shopping_list → ${status}, list id=${listId}`);
  } else {
    fail('create_shopping_list', `expected 200/201, got ${status}: ${JSON.stringify(data)}`);
    process.exit(1);
  }
}

// 3. Insert a shopping item directly via REST
{
  const { status, data } = await request(
    'POST',
    '/rest/v1/shopping_items',
    { list_id: listId, name: 'Bread', quantity: '1', checked: false },
    token
  );
  if (status === 201) {
    itemId = data?.id;
    ok(`insert item → ${status}, item id=${itemId}`);
  } else {
    fail('insert item', `expected 201, got ${status}: ${JSON.stringify(data)}`);
    process.exit(1);
  }
}

// 4. SELECT the item to verify it exists and is unchecked
{
  const { status, data } = await request('GET', `/rest/v1/shopping_items?id=eq.${itemId}`, undefined, token);
  if (status === 200 && Array.isArray(data) && data.length === 1 && data[0].checked === false) {
    ok(`select item → ${status}, checked=${data[0].checked}`);
  } else {
    fail('select item', `got ${status}: ${JSON.stringify(data)}`);
  }
}

// 5. PATCH to check the item — THIS IS THE BUG: should return 200, currently returns 500
{
  const { status, data } = await request(
    'PATCH',
    `/rest/v1/shopping_items?id=eq.${itemId}`,
    { checked: true },
    token
  );
  if (status === 200) {
    ok(`PATCH checked=true → ${status} ✓`);
  } else {
    fail(`PATCH checked=true`, `expected 200, got ${status}: ${JSON.stringify(data)}`);
  }
}

// 6. PATCH to uncheck the item
{
  const { status, data } = await request(
    'PATCH',
    `/rest/v1/shopping_items?id=eq.${itemId}`,
    { checked: false },
    token
  );
  if (status === 200) {
    ok(`PATCH checked=false → ${status} ✓`);
  } else {
    fail(`PATCH checked=false`, `expected 200, got ${status}: ${JSON.stringify(data)}`);
  }
}

// 7. Verify the item is back to unchecked
{
  const { status, data } = await request('GET', `/rest/v1/shopping_items?id=eq.${itemId}`, undefined, token);
  if (status === 200 && Array.isArray(data) && data.length === 1 && data[0].checked === false) {
    ok(`verify unchecked → ${status}, checked=${data[0].checked}`);
  } else {
    fail('verify unchecked', `got ${status}: ${JSON.stringify(data)}`);
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
