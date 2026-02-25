/**
 * E2E test: Auth endpoints (signup, login, refresh, get/update user, logout).
 *
 * Requires: proxy running with JWT_SECRET=test-secret-key
 *           + pgstack schema bootstrapped in pg_reactive_test DB
 */

const BASE = 'http://127.0.0.1:8080';

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

async function testSignupValidation() {
  console.log('\nTest 1: Signup validation');

  // Missing email
  let r = await api('POST', '/auth/v1/signup', { email: '', password: 'test123' });
  assert(r.status === 400, `empty email -> 400 (got ${r.status})`);

  // Bad email
  r = await api('POST', '/auth/v1/signup', { email: 'not-an-email', password: 'test123' });
  assert(r.status === 400, `invalid email -> 400 (got ${r.status})`);

  // Short password
  r = await api('POST', '/auth/v1/signup', { email: 'test@example.com', password: '12345' });
  assert(r.status === 400, `short password -> 400 (got ${r.status})`);
}

async function testSignupSuccess() {
  console.log('\nTest 2: Signup success');

  const email = `e2e-${Date.now()}@test.com`;
  const r = await api('POST', '/auth/v1/signup', {
    email,
    password: 'test-password-123',
    data: { display_name: 'E2E User' },
  });

  assert(r.status === 201, `signup -> 201 (got ${r.status})`);
  assert(r.json.access_token, 'has access_token');
  assert(r.json.refresh_token, 'has refresh_token');
  assert(r.json.token_type === 'bearer', 'token_type = bearer');
  assert(r.json.expires_in === 3600, 'expires_in = 3600');
  assert(r.json.user?.email === email, `user email = ${email}`);
  assert(r.json.user?.role === 'authenticated', 'user role = authenticated');
  assert(r.json.user?.user_metadata?.display_name === 'E2E User', 'user_metadata preserved');

  return { email, ...r.json };
}

async function testDuplicateSignup(email) {
  console.log('\nTest 3: Duplicate signup');

  const r = await api('POST', '/auth/v1/signup', { email, password: 'test-password-123' });
  assert(r.status === 409, `duplicate email -> 409 (got ${r.status})`);
}

async function testLoginPassword(email) {
  console.log('\nTest 4: Login with password');

  // Wrong password
  let r = await api('POST', '/auth/v1/token', {
    grant_type: 'password',
    email,
    password: 'wrong-password',
  });
  assert(r.status === 401, `wrong password -> 401 (got ${r.status})`);

  // Wrong email
  r = await api('POST', '/auth/v1/token', {
    grant_type: 'password',
    email: 'nonexistent@test.com',
    password: 'test-password-123',
  });
  assert(r.status === 401, `nonexistent user -> 401 (got ${r.status})`);

  // Correct login
  r = await api('POST', '/auth/v1/token', {
    grant_type: 'password',
    email,
    password: 'test-password-123',
  });
  assert(r.status === 200, `correct login -> 200 (got ${r.status})`);
  assert(r.json.access_token, 'has access_token');
  assert(r.json.refresh_token, 'has refresh_token');
  assert(r.json.user?.email === email, 'user email matches');

  return r.json;
}

async function testRefreshToken(refreshToken) {
  console.log('\nTest 5: Refresh token');

  // Invalid refresh token
  let r = await api('POST', '/auth/v1/token', {
    grant_type: 'refresh_token',
    refresh_token: 'invalid-token',
  });
  assert(r.status === 401, `invalid refresh -> 401 (got ${r.status})`);

  // Valid refresh
  r = await api('POST', '/auth/v1/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  assert(r.status === 200, `valid refresh -> 200 (got ${r.status})`);
  assert(r.json.access_token, 'has new access_token');
  assert(r.json.refresh_token, 'has new refresh_token');
  assert(r.json.refresh_token !== refreshToken, 'refresh token rotated');

  // Old token should be revoked
  const r2 = await api('POST', '/auth/v1/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  assert(r2.status === 401, `reused old refresh -> 401 (got ${r2.status})`);

  return r.json;
}

async function testGetUser(accessToken) {
  console.log('\nTest 6: Get user');

  // No token
  let r = await api('GET', '/auth/v1/user');
  assert(r.status === 401, `no token -> 401 (got ${r.status})`);

  // With token
  r = await api('GET', '/auth/v1/user', null, accessToken);
  assert(r.status === 200, `with token -> 200 (got ${r.status})`);
  assert(r.json.id, 'has user id');
  assert(r.json.email, 'has user email');
  assert(r.json.role === 'authenticated', 'role = authenticated');

  return r.json;
}

async function testUpdateUser(accessToken) {
  console.log('\nTest 7: Update user');

  // Update metadata
  let r = await api('PATCH', '/auth/v1/user', {
    data: { theme: 'dark', lang: 'en' },
  }, accessToken);
  assert(r.status === 200, `update metadata -> 200 (got ${r.status})`);
  assert(r.json.user_metadata?.theme === 'dark', 'metadata updated');

  // Update password
  r = await api('PATCH', '/auth/v1/user', {
    password: 'new-password-456',
  }, accessToken);
  assert(r.status === 200, `update password -> 200 (got ${r.status})`);

  return r.json;
}

async function testLoginWithNewPassword(email) {
  console.log('\nTest 8: Login with new password');

  // Old password should fail
  let r = await api('POST', '/auth/v1/token', {
    grant_type: 'password',
    email,
    password: 'test-password-123',
  });
  assert(r.status === 401, `old password -> 401 (got ${r.status})`);

  // New password should work
  r = await api('POST', '/auth/v1/token', {
    grant_type: 'password',
    email,
    password: 'new-password-456',
  });
  assert(r.status === 200, `new password -> 200 (got ${r.status})`);

  return r.json;
}

async function testLogout(accessToken, refreshToken) {
  console.log('\nTest 9: Logout');

  const r = await api('POST', '/auth/v1/logout', null, accessToken);
  assert(r.status === 204, `logout -> 204 (got ${r.status})`);

  // Refresh token should be revoked after logout
  const r2 = await api('POST', '/auth/v1/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  assert(r2.status === 401, `refresh after logout -> 401 (got ${r2.status})`);
}

async function testUnsupportedGrantType() {
  console.log('\nTest 10: Unsupported grant type');

  const r = await api('POST', '/auth/v1/token', { grant_type: 'magic_link' });
  assert(r.status === 400, `unsupported grant -> 400 (got ${r.status})`);
}

// ---- Main ----

async function main() {
  console.log('=== Auth Endpoints E2E Test ===');

  // 1. Validation
  await testSignupValidation();

  // 2. Signup
  const signup = await testSignupSuccess();

  // 3. Duplicate signup
  await testDuplicateSignup(signup.email);

  // 4. Login
  const login = await testLoginPassword(signup.email);

  // 5. Refresh
  const refreshed = await testRefreshToken(login.refresh_token);

  // 6. Get user
  await testGetUser(refreshed.access_token);

  // 7. Update user
  await testUpdateUser(refreshed.access_token);

  // 8. Login with updated password
  const relogin = await testLoginWithNewPassword(signup.email);

  // 9. Logout
  await testLogout(relogin.access_token, relogin.refresh_token);

  // 10. Unsupported grant type
  await testUnsupportedGrantType();

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Auth test error:', e);
  process.exit(1);
});
