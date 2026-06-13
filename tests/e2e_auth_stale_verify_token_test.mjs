/**
 * E2E: a stale email-verification token must not confirm a DIFFERENT email
 * (gemini audit, finding 2 / P1).
 *
 * Bug: pgstack.email_tokens bound a verification token only to user_id — not to
 * the email it was issued for — and an email change neither revoked outstanding
 * verification tokens nor re-bound them. So a token minted while the account was
 * email X would later confirm whatever the account's CURRENT email happened to
 * be (X -> Y), silently verifying an address the token was never issued for.
 *
 * Repro (this test):
 *   1. signup + verify email A, log in (so the account can change its email)
 *   2. inject a verification token T for the account (models an outstanding token)
 *   3. PATCH the email to C
 *   4. redeem T at /verify
 *   -> pre-fix: T confirms C, login on C succeeds   (FAIL here)
 *   -> post-fix: T is revoked on change AND bound to its issue-email, so C stays
 *      unverified and login on C is refused          (PASS)
 *
 * Requires: proxy on 127.0.0.1:8080 with REQUIRE_EMAIL_VERIFICATION=true (the
 * runner (re)creates proxy-go with that env, same as e2e_auth_email_verify_test).
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

// Inject an email_verification token issued for `email` and return its
// plaintext. Binds the token to the address it was minted for, exactly as the
// proxy now does — so the legit verification of A still works and the attack
// (an A-token confirming C) is blocked by BOTH the email binding and the
// revoke-on-change.
function injectToken(uid, email) {
  const plain = `stale-${crypto.randomBytes(8).toString('hex')}`;
  psql(`INSERT INTO pgstack.email_tokens (user_id, token_hash, token_type, email, expires_at) VALUES ('${uid}', '${sha256hex(plain)}', 'email_verification', '${email}', now() + interval '1 hour');`);
  return plain;
}

console.log('\n=== stale verification token must not confirm a different email ===');

const emailA = `stale-a-${Date.now()}@test.com`;
const emailC = `stale-c-${Date.now()}@test.com`;
const password = 'stale-token-password-123';

// 1. Signup A, verify it (inject + redeem), then log in.
await api('POST', '/auth/v1/signup', { email: emailA, password });
const uid = userId(emailA);
check(uid !== '', 'account A created');
const tA = injectToken(uid, emailA);
const vA = await api('GET', `/auth/v1/verify?token=${tA}`);
check(vA.status === 200 || vA.status === 303 || vA.status === 302, `email A verified (got ${vA.status})`);
const login = await api('POST', '/auth/v1/token', { grant_type: 'password', email: emailA, password });
check(login.status === 200 && login.json.access_token, `login on A succeeds (got ${login.status})`);
const access = login.json.access_token;

// 2. Inject an OUTSTANDING verification token T (issued while the email is A).
const tStale = injectToken(uid, emailA);

// 3. Change the email to C (authenticated). This must revoke T and re-arm
//    verification for C.
const change = await api('PATCH', '/auth/v1/user', { email: emailC }, access);
check(change.status === 200, `email change A->C accepted (got ${change.status})`);
check(confirmedAt(emailC) === 'NULL', 'C is unverified immediately after the change');

// 4. Redeem the stale token T. It must NOT confirm C.
const redeem = await api('GET', `/auth/v1/verify?token=${tStale}`);
check(confirmedAt(emailC) === 'NULL',
  `stale token did NOT confirm C (email_confirmed_at still NULL; got verify status ${redeem.status})`);

// 5. The whole point: login on C must stay refused.
const loginC = await api('POST', '/auth/v1/token', { grant_type: 'password', email: emailC, password });
check(loginC.status === 403, `login on C refused — stale token granted no verification (got ${loginC.status})`);

// cleanup
psql(`DELETE FROM pgstack.users WHERE email LIKE 'stale-a-%@test.com' OR email LIKE 'stale-c-%@test.com';`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — a stale verification token confirmed a different email.`);
  process.exit(1);
}
console.log('\nPASS: a verification token cannot confirm an email it was not issued for.');
