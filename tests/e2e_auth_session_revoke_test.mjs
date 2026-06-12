/**
 * E2E: a password reset (and an authenticated password change) must revoke every
 * pre-existing refresh token (gemini audit P1). A reset is the response to a
 * compromise; a stolen 30-day refresh that survives it can keep minting access
 * tokens. Reproduced before the fix: the old refresh returned 200 after reset.
 *
 * Requires: proxy on 127.0.0.1:8080 (verification off is fine for this path) and
 * the pgstack schema in pg_reactive_test.
 */
import crypto from 'crypto';
import { psql } from './helpers.mjs';

const BASE = 'http://127.0.0.1:8080';
let failures = 0;
const check = (cond, msg) => { cond ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), failures++); };

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json; const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function scenario(name, resetFn) {
  console.log(`\n=== ${name} ===`);
  const email = `revoke-${name}-${Date.now()}@test.com`;
  const password = 'orig-password-123';

  const signup = await api('POST', '/auth/v1/signup', { email, password });
  const refresh = signup.json && signup.json.refresh_token;
  if (!refresh) { check(false, `signup returned a refresh token (status ${signup.status})`); return; }

  // Sanity: the refresh works BEFORE the reset.
  const before = await api('POST', '/auth/v1/token', { grant_type: 'refresh_token', refresh_token: refresh });
  check(before.status === 200, `refresh token works before the reset (got ${before.status})`);
  // Use the rotated token if one came back, else the original (we want a still-valid one).
  const liveRefresh = (before.json && before.json.refresh_token) || refresh;

  await resetFn(email, password);

  // The pre-reset refresh must now be rejected.
  const after = await api('POST', '/auth/v1/token', { grant_type: 'refresh_token', refresh_token: liveRefresh });
  check(after.status === 401, `refresh token is REVOKED after the reset/change (got ${after.status})`);
}

// Finding 3: password recovery (POST /auth/v1/recover/confirm) revokes sessions.
await scenario('recovery', async (email) => {
  const uid = psql(`SELECT id FROM pgstack.users WHERE email='${email}';`).trim();
  const plain = `recover-${crypto.randomBytes(8).toString('hex')}`;
  psql(`INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, expires_at) VALUES ('${uid}', '${sha256hex(plain)}', 'recovery', now() + interval '1 hour');`);
  const r = await api('POST', '/auth/v1/recover/confirm', { token: plain, password: 'brand-new-password-456' });
  check(r.status === 200, `recover/confirm succeeded (got ${r.status})`);
});

// Finding 3 (corollary): authenticated password change also revokes other sessions.
await scenario('password-change', async (email, password) => {
  const login = await api('POST', '/auth/v1/token', { grant_type: 'password', email, password });
  const access = login.json && login.json.access_token;
  check(!!access, 'logged in to obtain an access token for the change');
  const r = await api('PATCH', '/auth/v1/user', { password: 'changed-password-789' }, access);
  check(r.status === 200, `password change succeeded (got ${r.status})`);
});

// cleanup
psql(`DELETE FROM pgstack.users WHERE email LIKE 'revoke-%@test.com';`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — a reset/change left a usable refresh token.`);
  process.exit(1);
}
console.log('\nPASS: password reset and change revoke pre-existing refresh tokens.');
