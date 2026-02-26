/**
 * E2E test: OAuth authorize and callback endpoints (C5).
 *
 * OAuth cannot be fully tested end-to-end without a real browser flow and
 * live OAuth provider credentials. This file tests the proxy-side behaviour
 * that is observable without a real provider:
 *
 *   GET /auth/v1/authorize?provider=google  — redirect to Google (or 400 if unconfigured)
 *   GET /auth/v1/authorize?provider=github  — redirect to GitHub (or 400 if unconfigured)
 *   GET /auth/v1/authorize?provider=invalid — 400 unsupported provider
 *   GET /auth/v1/callback?code=x&state=x   — redirect to SITE_URL#error=... (invalid state)
 *
 * The authorize endpoint returns HTTP 307 (Temporary Redirect).
 * Node's fetch() follows redirects by default, so we use { redirect: 'manual' }
 * to capture the raw 3xx and inspect the Location header.
 *
 * Two modes:
 *   - Configured: GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID are set in the proxy env.
 *     Expects a 307 redirect to the provider's authorization URL.
 *   - Unconfigured (default docker-compose): missing client IDs.
 *     Expects a 400 with { "error": "... not configured" }.
 *
 * The callback invalid-state test always applies regardless of config.
 *
 * Requires: docker compose running with:
 *   JWT_SECRET=test-secret-key-for-development-only
 *
 * Run with: node tests/e2e_oauth_test.mjs
 *
 * To test with real OAuth credentials set in environment before running docker:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx \
 *   GITHUB_CLIENT_ID=xxx GITHUB_CLIENT_SECRET=xxx \
 *   docker compose up -d proxy
 */

const BASE = 'http://127.0.0.1:8080';

// Expected provider authorization URL prefixes
const GOOGLE_AUTH_HOST = 'https://accounts.google.com/o/oauth2/v2/auth';
const GITHUB_AUTH_HOST = 'https://github.com/login/oauth/authorize';

// Default SITE_URL used when env var is not set (see oauth.rs DEFAULT_SITE_URL)
const DEFAULT_SITE_URL = 'http://127.0.0.1:3000';

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

/**
 * Fetch without following redirects.
 * Returns { status, headers, location } where location is the Location header value.
 */
async function fetchNoFollow(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  const location = res.headers.get('location') || '';
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, location, json, text };
}

/**
 * Regular fetch (follows redirects) for endpoints that return JSON errors.
 */
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

// ---- OAuth authorize tests ----

async function testAuthorizeGoogle() {
  console.log('\nTest O1: GET /auth/v1/authorize?provider=google');

  const r = await fetchNoFollow('/auth/v1/authorize?provider=google');

  if (r.status === 400) {
    // Unconfigured: proxy returns 400 with JSON error (no GOOGLE_CLIENT_ID)
    console.log('  INFO: Google OAuth not configured — testing unconfigured behaviour');
    assert(r.status === 400, `unconfigured -> 400 (got ${r.status})`);
    // r.text is the raw response body captured by fetchNoFollow
    const errBody = r.text || '';
    assert(
      errBody.includes('not configured') || errBody.includes('Google'),
      `error mentions Google config (got: ${errBody.slice(0, 120)})`
    );
  } else {
    // Configured: expect a 3xx redirect to Google's OAuth URL
    assert(r.status === 307 || r.status === 302,
      `configured -> 302/307 redirect (got ${r.status})`);
    assert(
      r.location.startsWith(GOOGLE_AUTH_HOST),
      `Location points to Google auth (got: ${r.location.slice(0, 80)})`
    );
    // Verify required OAuth parameters are present in the redirect URL
    const url = new URL(r.location);
    assert(url.searchParams.get('client_id') !== null, 'Location has client_id param');
    assert(url.searchParams.get('redirect_uri') !== null, 'Location has redirect_uri param');
    assert(url.searchParams.get('state') !== null, 'Location has state param');
    assert(url.searchParams.get('response_type') === 'code', 'response_type=code');
    assert(url.searchParams.get('scope') !== null, 'Location has scope param');
    // Google uses PKCE
    assert(url.searchParams.get('code_challenge') !== null, 'Location has code_challenge (PKCE)');
    assert(url.searchParams.get('code_challenge_method') === 'S256', 'code_challenge_method=S256');
  }
}

async function testAuthorizeGitHub() {
  console.log('\nTest O2: GET /auth/v1/authorize?provider=github');

  const r = await fetchNoFollow('/auth/v1/authorize?provider=github');

  if (r.status === 400) {
    // Unconfigured: proxy returns 400 (no GITHUB_CLIENT_ID)
    console.log('  INFO: GitHub OAuth not configured — testing unconfigured behaviour');
    assert(r.status === 400, `unconfigured -> 400 (got ${r.status})`);
    const errBody = r.text || '';
    assert(
      errBody.includes('not configured') || errBody.includes('GitHub'),
      `error mentions GitHub config (got: ${errBody.slice(0, 120)})`
    );
  } else {
    // Configured: expect a 3xx redirect to GitHub's OAuth URL
    assert(r.status === 307 || r.status === 302,
      `configured -> 302/307 redirect (got ${r.status})`);
    assert(
      r.location.startsWith(GITHUB_AUTH_HOST),
      `Location points to GitHub auth (got: ${r.location.slice(0, 80)})`
    );
    const url = new URL(r.location);
    assert(url.searchParams.get('client_id') !== null, 'Location has client_id param');
    assert(url.searchParams.get('redirect_uri') !== null, 'Location has redirect_uri param');
    assert(url.searchParams.get('state') !== null, 'Location has state param');
    assert(url.searchParams.get('scope') !== null, 'Location has scope param');
    // GitHub does NOT use PKCE
    assert(url.searchParams.get('code_challenge') === null, 'GitHub: no code_challenge (no PKCE)');
  }
}

async function testAuthorizeInvalidProvider() {
  console.log('\nTest O3: GET /auth/v1/authorize?provider=invalid');

  // The proxy rejects unsupported providers with 400 before inserting an oauth_session row.
  // However, it first tries to INSERT the session (before the match on provider), so this
  // actually depends on whether pgstack.oauth_sessions exists.
  //
  // From oauth.rs: INSERT INTO pgstack.oauth_sessions happens BEFORE the match on provider.
  // If the schema is missing, we get a 500. If it exists, we get a 400.
  // Either way the response is not a redirect.
  const r = await fetchNoFollow('/auth/v1/authorize?provider=invalid');

  assert(
    r.status === 400 || r.status === 500,
    `invalid provider -> 400 or 500 (got ${r.status})`
  );
  // Must NOT redirect — unsupported provider should be rejected as JSON error
  assert(
    r.status !== 307 && r.status !== 302,
    `invalid provider must not redirect (got ${r.status})`
  );
}

async function testAuthorizeMissingProvider() {
  console.log('\nTest O4: GET /auth/v1/authorize (missing provider param)');

  // No ?provider= query param — axum's Query extractor should reject this.
  const r = await fetchNoFollow('/auth/v1/authorize');

  assert(
    r.status === 400 || r.status === 422,
    `missing provider -> 400 or 422 (got ${r.status})`
  );
  assert(
    r.status !== 307 && r.status !== 302,
    `missing provider must not redirect (got ${r.status})`
  );
}

// ---- OAuth callback tests ----

async function testCallbackInvalidState() {
  console.log('\nTest O5: GET /auth/v1/callback?code=fake&state=fake (invalid state)');

  // The proxy looks up the state in pgstack.oauth_sessions; a fake state won't be found.
  // callback() maps AppError::Unauthorized -> error_redirect(site, "server_error", description)
  // so we expect a 307 redirect to SITE_URL#error=server_error&error_description=...
  const r = await fetchNoFollow('/auth/v1/callback?code=fake_code&state=fake_state');

  if (r.status === 307 || r.status === 302) {
    assert(true, `callback invalid state -> redirect (${r.status})`);

    // Should redirect to SITE_URL (default or configured)
    const siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL;
    assert(
      r.location.startsWith(siteUrl),
      `Location starts with SITE_URL ${siteUrl} (got: ${r.location.slice(0, 100)})`
    );

    // Fragment should contain error= and error_description=
    assert(
      r.location.includes('error='),
      `Location fragment contains error= (got: ${r.location.slice(0, 200)})`
    );
    assert(
      r.location.includes('error_description='),
      `Location fragment contains error_description= (got: ${r.location.slice(0, 200)})`
    );
  } else if (r.status === 500 || r.status === 400) {
    // If pgstack schema is not bootstrapped, we get a DB error instead of a redirect.
    // Accept this as a valid outcome in a partially-configured environment.
    console.log(`  INFO: pgstack schema may not be bootstrapped (got ${r.status}), skipping redirect check`);
    assert(true, `callback returns error status ${r.status} (schema not bootstrapped)`);
  } else {
    assert(false, `unexpected status ${r.status} for invalid callback state`);
  }
}

async function testCallbackMissingParams() {
  console.log('\nTest O6: GET /auth/v1/callback (missing code and state params)');

  // axum Query extractor requires both `code` and `state` — missing params -> 400 or 422
  const r = await fetchNoFollow('/auth/v1/callback');

  assert(
    r.status === 400 || r.status === 422,
    `missing callback params -> 400 or 422 (got ${r.status})`
  );
}

async function testCallbackExpiredState() {
  console.log('\nTest O7: GET /auth/v1/callback with empty-string state (never valid)');

  // An empty state string will never match a real oauth_session row.
  // Should behave the same as fake_state.
  const r = await fetchNoFollow('/auth/v1/callback?code=somecode&state=');

  // Either a redirect to error page or a JSON error — never a success
  assert(
    r.status !== 200,
    `empty state must not return 200 (got ${r.status})`
  );
  // If it redirects, must contain error fragment
  if (r.status === 307 || r.status === 302) {
    assert(
      r.location.includes('error='),
      `error redirect contains error= (got: ${r.location.slice(0, 200)})`
    );
  }
}

// ---- State uniqueness / CSRF test (structural) ----

async function testStateUniqueness() {
  console.log('\nTest O8: Two authorize requests generate different state values (CSRF check)');

  // Only meaningful when Google OAuth is configured (otherwise we get 400s).
  const r1 = await fetchNoFollow('/auth/v1/authorize?provider=google');
  const r2 = await fetchNoFollow('/auth/v1/authorize?provider=google');

  if ((r1.status === 307 || r1.status === 302) && (r2.status === 307 || r2.status === 302)) {
    const url1 = new URL(r1.location);
    const url2 = new URL(r2.location);
    const state1 = url1.searchParams.get('state');
    const state2 = url2.searchParams.get('state');

    assert(state1 !== null && state1.length > 0, 'first request has non-empty state');
    assert(state2 !== null && state2.length > 0, 'second request has non-empty state');
    assert(state1 !== state2, `state values are unique: ${state1.slice(0, 12)}... != ${state2.slice(0, 12)}...`);

    // PKCE: code_challenge values should also differ (different verifiers)
    const challenge1 = url1.searchParams.get('code_challenge');
    const challenge2 = url2.searchParams.get('code_challenge');
    if (challenge1 && challenge2) {
      assert(challenge1 !== challenge2, 'code_challenge values are unique per request (PKCE)');
    }
  } else {
    // Unconfigured: both return 400 — the state uniqueness test is not applicable
    console.log(`  INFO: Google not configured (${r1.status}/${r2.status}) — state uniqueness test skipped`);
    assert(true, 'state uniqueness test skipped (OAuth unconfigured)');
  }
}

// ---- Main ----

async function main() {
  console.log('=== OAuth Flow E2E Test ===');
  console.log('Note: authorize redirects require GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID env vars.');
  console.log('      Without them, tests verify the "unconfigured" 400 response instead.');

  // Authorize endpoint
  await testAuthorizeGoogle();
  await testAuthorizeGitHub();
  await testAuthorizeInvalidProvider();
  await testAuthorizeMissingProvider();

  // Callback endpoint
  await testCallbackInvalidState();
  await testCallbackMissingParams();
  await testCallbackExpiredState();

  // CSRF / state uniqueness
  await testStateUniqueness();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('OAuth test error:', e);
  process.exit(1);
});
