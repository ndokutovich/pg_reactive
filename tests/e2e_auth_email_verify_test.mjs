/**
 * E2E: REQUIRE_EMAIL_VERIFICATION actually blocks unverified logins (gemini audit
 * P1). The schema previously defaulted email_confirmed_at to now(), so every
 * signup was auto-confirmed and the login gate ("email_confirmed_at IS NULL")
 * could never fire. And an email change inherited the old confirmed status.
 *
 * Run against a proxy started with REQUIRE_EMAIL_VERIFICATION=true. The runner
 * (re)creates proxy-go with that env before invoking this test.
 *
 * Requires: proxy on 127.0.0.1:8080 with REQUIRE_EMAIL_VERIFICATION=true, and the
 * pgstack schema in pg_reactive_test.
 */
import crypto from 'crypto';
import { psql } from './helpers.mjs';

const BASE = 'http://127.0.0.1:8080';
let failures = 0;
const check = (cond, msg) => { cond ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), failures++); };

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json; const text = await res.text();
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const confirmedAt = (email) =>
  psql(`SELECT COALESCE(email_confirmed_at::text,'NULL') FROM pgstack.users WHERE email='${email}';`).trim();
const userId = (email) => psql(`SELECT id FROM pgstack.users WHERE email='${email}';`).trim();

// Inject a verification token and confirm via the real endpoint.
async function verify(email) {
  const plain = `verify-${crypto.randomBytes(8).toString('hex')}`;
  // Bind the token to the address it confirms — the proxy now requires the
  // token's email to still match the user's current email (gemini finding 2).
  psql(`INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, email, expires_at) VALUES ('${userId(email)}', '${sha256hex(plain)}', 'email_verification', '${email}', now() + interval '1 hour');`);
  return api('GET', `/auth/v1/verify?token=${plain}`);
}

console.log('\n=== REQUIRE_EMAIL_VERIFICATION blocks unverified logins ===');

const email = `verify-${Date.now()}@test.com`;
const password = 'verify-password-123';

// 1. Signup must NOT auto-confirm.
const signup = await api('POST', '/auth/v1/signup', { email, password });
check(signup.status === 200, `signup returns 200 'check your email' (got ${signup.status})`);
check(!(signup.json && signup.json.access_token), 'signup did NOT issue tokens (unverified)');
check(confirmedAt(email) === 'NULL', 'email_confirmed_at is NULL after signup (not auto-confirmed)');

// 2. Login is refused until verified.
const loginBefore = await api('POST', '/auth/v1/token', { grant_type: 'password', email, password });
check(loginBefore.status === 403, `login refused before verification -> 403 (got ${loginBefore.status})`);

// 3. Verify, then login succeeds.
const v = await verify(email);
check(v.status === 200 || v.status === 303 || v.status === 302, `verify endpoint accepted the token (got ${v.status})`);
check(confirmedAt(email) !== 'NULL', 'email_confirmed_at is set after verification');
const loginAfter = await api('POST', '/auth/v1/token', { grant_type: 'password', email, password });
check(loginAfter.status === 200, `login succeeds after verification -> 200 (got ${loginAfter.status})`);

// 4. Changing the email clears confirmation: the new address must re-verify.
const access = loginAfter.json.access_token;
const newEmail = `verify-changed-${Date.now()}@test.com`;
const change = await api('PATCH', '/auth/v1/user', { email: newEmail }, access);
check(change.status === 200, `email change accepted (got ${change.status})`);
check(confirmedAt(newEmail) === 'NULL', 'email_confirmed_at cleared after email change (new address unverified)');
const loginChanged = await api('POST', '/auth/v1/token', { grant_type: 'password', email: newEmail, password });
check(loginChanged.status === 403, `login on the changed (unverified) email -> 403 (got ${loginChanged.status})`);

// cleanup
psql(`DELETE FROM pgstack.users WHERE email LIKE 'verify-%@test.com';`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — email verification is not enforced.`);
  process.exit(1);
}
console.log('\nPASS: unverified users cannot log in; email change forces re-verification.');
