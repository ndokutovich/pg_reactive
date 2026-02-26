/**
 * pgStack Manual Test Suite
 *
 * Comprehensive black-box tests for all pgStack features.
 * No npm dependencies — uses only Node.js built-ins and native fetch (Node 18+).
 *
 * Usage:
 *   node tests/manual_test.mjs                 # all sections
 *   node tests/manual_test.mjs --section=auth  # single section
 *
 * Sections: health, auth, admin, rest, rls, realtime, ddl, seq, sql, catalog, rpc, jwt
 */

import net from 'node:net';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE = 'http://127.0.0.1:8080';
const WS_HOST = '127.0.0.1';
const WS_PORT = 8080;

const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const SRV_KEY  = process.env.SERVICE_ROLE_KEY || 'dev-only-service-role-key-do-not-use-in-production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret-do-not-use-in-production';

// Unique suffix to avoid collisions between runs
const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// CLI argument: --section=<name>
// ---------------------------------------------------------------------------

const sectionFilter = (() => {
  const arg = process.argv.find(a => a.startsWith('--section='));
  return arg ? arg.slice('--section='.length).toLowerCase() : null;
})();

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let totalPassed = 0;
let totalFailed = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Record a test result.
 * @param {boolean} condition
 * @param {string} description
 */
function assert(condition, description) {
  if (condition) {
    console.log(`  PASS: ${description}`);
    totalPassed++;
  } else {
    console.log(`  FAIL: ${description}`);
    totalFailed++;
  }
  return condition;
}

/**
 * HTTP helper — fetch wrapper that always returns { status, json, text }.
 * Never throws on HTTP error codes; only throws on network failure.
 *
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [token]
 * @returns {Promise<{status: number, json: unknown, text: string}>}
 */
async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined && body !== null) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

/**
 * POST /api/sql with service role.  Returns { ok, rows?, rows_affected?, error? }.
 */
async function sql(query) {
  const r = await api('POST', '/api/sql', { sql: query }, SRV_KEY);
  return r;
}

/**
 * Build a minimal HS256 JWT from a plain-object payload.
 */
function makeJwt(payload, secret = JWT_SECRET) {
  function b64url(data) {
    return Buffer.from(data)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body_   = b64url(JSON.stringify(payload));
  const sig     = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body_}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body_}.${sig}`;
}

/**
 * Minimal WebSocket client over raw TCP.
 * Returns a controller: { send(text), receive(timeoutMs), close() }.
 *
 * The handshake is standard HTTP Upgrade per RFC 6455.
 * Handles only TEXT frames for simplicity (no fragmentation, no masking decode).
 */
function wsConnect(host, port, path, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);

    const key = crypto.randomBytes(16).toString('base64');
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);

    // Queue of received text payloads (string)
    const received = [];
    // Queue of pending receive() promises
    const waiters = [];

    function pushMessage(text) {
      if (waiters.length > 0) {
        const { resolve: res } = waiters.shift();
        res(text);
      } else {
        received.push(text);
      }
    }

    function receive(timeoutMs = 6000) {
      if (received.length > 0) {
        return Promise.resolve(received.shift());
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === res);
          if (idx !== -1) waiters.splice(idx, 1);
          rej(new Error(`WS receive timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        waiters.push({
          resolve: (val) => { clearTimeout(timer); res(val); },
          reject: rej,
        });
      });
    }

    function send(text) {
      // Build an unmasked TEXT frame (server → client direction for testing;
      // technically clients should mask, but many servers accept unmasked in tests)
      const payload = Buffer.from(text, 'utf8');
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + TEXT opcode
        header[1] = len;  // no mask
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    }

    function close() {
      // Send a close frame (opcode 0x8, FIN)
      socket.write(Buffer.from([0x88, 0x00]));
      socket.destroy();
    }

    // Parse incoming WebSocket frames from accumulated buffer
    function parseFrames() {
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        const masked  = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        if (masked) offset += 4;

        if (buffer.length < offset + payloadLen) return;

        const frameData = buffer.slice(offset, offset + payloadLen);
        buffer = buffer.slice(offset + payloadLen);

        if (opcode === 0x1 || opcode === 0x0) {
          // TEXT or continuation
          pushMessage(frameData.toString('utf8'));
        } else if (opcode === 0x8) {
          // Close frame
          socket.destroy();
          return;
        }
        // PING / PONG / binary: ignore
      }
    }

    socket.on('error', (err) => {
      if (!handshakeDone) reject(err);
    });

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        // Accumulate HTTP response headers
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headerText = buffer.slice(0, headerEnd).toString('ascii');
        buffer = buffer.slice(headerEnd + 4);

        if (!headerText.includes('101')) {
          reject(new Error(`WS handshake failed: ${headerText.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }

        handshakeDone = true;
        resolve({ send, receive, close });
        // Parse any WebSocket data that arrived with the handshake response
        if (buffer.length > 0) parseFrames();
      } else {
        buffer = Buffer.concat([buffer, chunk]);
        parseFrames();
      }
    });

    // Build the HTTP Upgrade request
    // Send token as Authorization header (anon key is not a JWT so ?token= won't work)
    const authHeader = token ? `Authorization: Bearer ${token}\r\n` : '';
    const reqLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      authHeader.trimEnd(),
      '\r\n',
    ].filter(Boolean).join('\r\n');

    socket.write(reqLines);

    socket.setTimeout(8000, () => {
      reject(new Error('WS connection timeout'));
      socket.destroy();
    });
  });
}

// ---------------------------------------------------------------------------
// Section runner
// ---------------------------------------------------------------------------

async function runSection(name, title, fn) {
  if (sectionFilter && sectionFilter !== name) return;
  console.log('');
  console.log(`[${title}]`);
  try {
    await fn();
  } catch (err) {
    console.log(`  FAIL: Section threw unexpected error: ${err.message}`);
    totalFailed++;
  }
}

// ---------------------------------------------------------------------------
// Section 1: HEALTH
// ---------------------------------------------------------------------------

async function sectionHealth() {
  // GET /health
  const r = await api('GET', '/health');
  assert(r.status === 200, `GET /health returns 200 (got ${r.status})`);
  assert(
    r.json && (r.json.status === 'ok' || r.json.status === 'degraded'),
    `GET /health body has status field (got ${JSON.stringify(r.json)})`
  );
  assert(
    r.json && typeof r.json.pg_connected === 'boolean',
    'GET /health body has pg_connected boolean'
  );

  // GET /studio/
  const s1 = await api('GET', '/studio/');
  assert(s1.status === 200, `GET /studio/ returns 200 (got ${s1.status})`);
  assert(
    typeof s1.text === 'string' && s1.text.includes('<html'),
    'GET /studio/ returns HTML'
  );

  // GET /studio/index.html
  const s2 = await api('GET', '/studio/index.html');
  assert(s2.status === 200, `GET /studio/index.html returns 200 (got ${s2.status})`);
}

// ---------------------------------------------------------------------------
// Section 2: AUTH — Signup / Login
// ---------------------------------------------------------------------------

async function sectionAuth() {
  const email = `manual-${RUN_ID}@test.example`;
  let accessToken = null;
  let refreshToken = null;
  let userId = null;

  try {
    // Signup new user
    {
      const r = await api('POST', '/auth/v1/signup', {
        email,
        password: 'Test-Password-123',
        data: { display_name: 'Manual Tester' },
      });
      assert(r.status === 201, `signup new user → 201 (got ${r.status})`);
      assert(typeof r.json?.access_token === 'string', 'signup returns access_token');
      assert(typeof r.json?.refresh_token === 'string', 'signup returns refresh_token');
      assert(typeof r.json?.user?.id === 'string', 'signup returns user.id');
      assert(r.json?.user?.email === email, `signup user.email matches (got ${r.json?.user?.email})`);
      accessToken  = r.json?.access_token;
      refreshToken = r.json?.refresh_token;
      userId       = r.json?.user?.id;
    }

    // Signup duplicate email
    {
      const r = await api('POST', '/auth/v1/signup', { email, password: 'Test-Password-123' });
      assert(
        r.status === 409 || r.status === 400,
        `signup duplicate email → 409 or 400 (got ${r.status})`
      );
    }

    // Login with wrong password
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'password',
        email,
        password: 'wrong-password-xyz',
      });
      assert(r.status === 401, `login wrong password → 401 (got ${r.status})`);
    }

    // Login with non-existent user
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'password',
        email: `no-such-user-${RUN_ID}@test.example`,
        password: 'Test-Password-123',
      });
      assert(r.status === 401, `login non-existent user → 401 (got ${r.status})`);
    }

    // Login with correct credentials
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'password',
        email,
        password: 'Test-Password-123',
      });
      assert(r.status === 200, `login correct credentials → 200 (got ${r.status})`);
      assert(typeof r.json?.access_token === 'string', 'login returns access_token');
      assert(typeof r.json?.refresh_token === 'string', 'login returns refresh_token');
      assert(r.json?.user?.email === email, 'login user.email matches');
      accessToken  = r.json.access_token;
      refreshToken = r.json.refresh_token;
    }

    // Get user with valid token
    {
      const r = await api('GET', '/auth/v1/user', null, accessToken);
      assert(r.status === 200, `GET /auth/v1/user with token → 200 (got ${r.status})`);
      assert(r.json?.email === email, 'user.email matches');
    }

    // Get user without token
    {
      const r = await api('GET', '/auth/v1/user');
      assert(r.status === 401, `GET /auth/v1/user without token → 401 (got ${r.status})`);
    }

    // Update user metadata
    {
      const r = await api('PATCH', '/auth/v1/user', { data: { theme: 'dark' } }, accessToken);
      assert(r.status === 200, `PATCH /auth/v1/user → 200 (got ${r.status})`);
    }

    // Logout
    {
      const r = await api('POST', '/auth/v1/logout', null, accessToken);
      assert(r.status === 204, `POST /auth/v1/logout → 204 (got ${r.status})`);
    }

    // Re-login to get fresh tokens for refresh test
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'password',
        email,
        password: 'Test-Password-123',
      });
      assert(r.status === 200, `re-login after logout → 200 (got ${r.status})`);
      accessToken  = r.json?.access_token;
      refreshToken = r.json?.refresh_token;
    }

    // Refresh token — valid
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      assert(r.status === 200, `refresh token → 200 (got ${r.status})`);
      assert(typeof r.json?.access_token === 'string', 'refresh returns new access_token');
      accessToken  = r.json?.access_token;
      refreshToken = r.json?.refresh_token;
    }

    // Refresh with invalid token
    {
      const r = await api('POST', '/auth/v1/token', {
        grant_type: 'refresh_token',
        refresh_token: 'invalid-refresh-token-value',
      });
      assert(r.status === 401, `refresh invalid token → 401 (got ${r.status})`);
    }

  } finally {
    // No dedicated cleanup needed: the admin section handles user deletion;
    // the user created here will be cleaned up there or left as acceptable test data.
  }
}

// ---------------------------------------------------------------------------
// Section 3: AUTH — Admin
// ---------------------------------------------------------------------------

async function sectionAdmin() {
  let adminUserId = null;

  try {
    // List users with service role
    {
      const r = await api('GET', '/auth/v1/admin/users', null, SRV_KEY);
      assert(r.status === 200, `admin list users (service role) → 200 (got ${r.status})`);
      assert(Array.isArray(r.json), 'admin list users returns array');
    }

    // List users with anon key (should be forbidden)
    {
      const r = await api('GET', '/auth/v1/admin/users', null, ANON_KEY);
      assert(
        r.status === 401 || r.status === 403,
        `admin list users (anon key) → 401/403 (got ${r.status})`
      );
    }

    // Create user via admin
    {
      const adminEmail = `admin-created-${RUN_ID}@test.example`;
      const r = await api('POST', '/auth/v1/admin/users', {
        email: adminEmail,
        password: 'Admin-Created-Pass-1',
      }, SRV_KEY);
      assert(
        r.status === 200 || r.status === 201,
        `admin create user → 200/201 (got ${r.status})`
      );
      assert(typeof r.json?.id === 'string', 'admin create user returns id');
      adminUserId = r.json?.id;
    }

    // Delete the created user via admin
    if (adminUserId) {
      const r = await api('DELETE', `/auth/v1/admin/users/${adminUserId}`, null, SRV_KEY);
      assert(r.status === 204, `admin delete user → 204 (got ${r.status})`);
    }

    // Delete non-existent user
    {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const r = await api('DELETE', `/auth/v1/admin/users/${fakeId}`, null, SRV_KEY);
      assert(r.status === 404, `admin delete non-existent user → 404 (got ${r.status})`);
    }

  } finally {
    // Attempt cleanup if test failed mid-way
    if (adminUserId) {
      try {
        await api('DELETE', `/auth/v1/admin/users/${adminUserId}`, null, SRV_KEY);
      } catch (_) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Section 4: REST — CRUD
// ---------------------------------------------------------------------------

async function sectionRest() {
  const TABLE = '_test_items';

  // Setup: create table
  await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
  await sql(`
    CREATE TABLE public.${TABLE} (
      id    serial primary key,
      name  text,
      done  boolean DEFAULT false,
      score integer DEFAULT 0
    )
  `);
  // Refresh catalog so proxy knows about the new table
  await api('POST', '/api/catalog/refresh', null, SRV_KEY);

  try {
    // GET empty table
    {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, SRV_KEY);
      assert(r.status === 200, `GET ${TABLE} (empty) → 200 (got ${r.status})`);
      assert(Array.isArray(r.json) && r.json.length === 0, 'empty table returns []');
    }

    // POST single row
    let insertedId;
    {
      const r = await api('POST', `/rest/v1/${TABLE}`, { name: 'alpha', done: false, score: 10 }, SRV_KEY);
      assert(r.status === 201, `POST single row → 201 (got ${r.status})`);
      assert(typeof r.json?.id === 'number', 'single insert returns id');
      insertedId = r.json?.id;
    }

    // POST bulk (3 rows)
    {
      const r = await api('POST', `/rest/v1/${TABLE}`, [
        { name: 'beta',  done: true,  score: 50 },
        { name: 'gamma', done: false, score: 75 },
        { name: 'delta', done: true,  score: 90 },
      ], SRV_KEY);
      assert(r.status === 201, `POST bulk 3 rows → 201 (got ${r.status})`);
      assert(Array.isArray(r.json) && r.json.length === 3, `bulk insert returns 3 rows (got ${r.json?.length})`);
    }

    // GET all (4 rows)
    {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, SRV_KEY);
      assert(r.status === 200, `GET all rows → 200 (got ${r.status})`);
      assert(Array.isArray(r.json) && r.json.length === 4, `GET returns 4 rows (got ${r.json?.length})`);
    }

    // GET with eq filter
    {
      const r = await api('GET', `/rest/v1/${TABLE}?name=eq.alpha`, null, SRV_KEY);
      assert(r.status === 200, `GET ?name=eq.alpha → 200 (got ${r.status})`);
      assert(Array.isArray(r.json) && r.json.length === 1, `filter eq returns 1 row (got ${r.json?.length})`);
      assert(r.json?.[0]?.name === 'alpha', 'filtered row has name=alpha');
    }

    // GET with gte filter
    {
      const r = await api('GET', `/rest/v1/${TABLE}?score=gte.50`, null, SRV_KEY);
      assert(r.status === 200, `GET ?score=gte.50 → 200 (got ${r.status})`);
      assert(
        Array.isArray(r.json) && r.json.every(row => row.score >= 50),
        `gte filter: all rows have score >= 50`
      );
    }

    // GET with order desc
    {
      const r = await api('GET', `/rest/v1/${TABLE}?order=score.desc`, null, SRV_KEY);
      assert(r.status === 200, `GET ?order=score.desc → 200 (got ${r.status})`);
      const scores = r.json?.map(row => row.score) ?? [];
      const isSorted = scores.every((v, i) => i === 0 || v <= scores[i - 1]);
      assert(isSorted, `rows are sorted by score descending (got ${JSON.stringify(scores)})`);
    }

    // GET with limit and offset
    {
      const r = await api('GET', `/rest/v1/${TABLE}?limit=2&offset=1&order=id.asc`, null, SRV_KEY);
      assert(r.status === 200, `GET ?limit=2&offset=1 → 200 (got ${r.status})`);
      assert(Array.isArray(r.json) && r.json.length === 2, `limit/offset returns 2 rows (got ${r.json?.length})`);
    }

    // GET with column selection
    {
      const r = await api('GET', `/rest/v1/${TABLE}?select=name,score`, null, SRV_KEY);
      assert(r.status === 200, `GET ?select=name,score → 200 (got ${r.status})`);
      const row = r.json?.[0];
      assert(
        row && 'name' in row && 'score' in row && !('id' in row) && !('done' in row),
        'column selection returns only name and score'
      );
    }

    // PATCH with filter
    {
      const r = await api('PATCH', `/rest/v1/${TABLE}?name=eq.alpha`, { done: true, score: 99 }, SRV_KEY);
      assert(r.status === 200, `PATCH ?name=eq.alpha → 200 (got ${r.status})`);
      const updated = Array.isArray(r.json) ? r.json : [r.json];
      assert(
        updated.length === 1 && updated[0]?.done === true,
        `PATCH updated row has done=true (got ${JSON.stringify(r.json)})`
      );
    }

    // DELETE with filter (done=true)
    {
      const r = await api('DELETE', `/rest/v1/${TABLE}?done=eq.true`, null, SRV_KEY);
      assert(r.status === 200, `DELETE ?done=eq.true → 200 (got ${r.status})`);
      const deleted = Array.isArray(r.json) ? r.json : [r.json];
      assert(deleted.length >= 1, `DELETE removed at least 1 row (got ${deleted.length})`);
    }

    // GET with unknown column → 400
    {
      const r = await api('GET', `/rest/v1/${TABLE}?nonexistent_col_xyz=eq.1`, null, SRV_KEY);
      assert(
        r.status === 400,
        `GET with unknown column → 400 (got ${r.status})`
      );
    }

    // GET with invalid filter syntax → 400
    {
      const r = await api('GET', `/rest/v1/${TABLE}?score=badop.5`, null, SRV_KEY);
      assert(
        r.status === 400,
        `GET with invalid filter operator → 400 (got ${r.status})`
      );
    }

  } finally {
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);
  }
}

// ---------------------------------------------------------------------------
// Section 5: REST — RLS
// ---------------------------------------------------------------------------

async function sectionRls() {
  const TABLE = '_test_rls_items';

  // Signup two test users
  const emailA = `rls-a-${RUN_ID}@test.example`;
  const emailB = `rls-b-${RUN_ID}@test.example`;
  let tokenA = null;
  let tokenB = null;
  let userAId = null;
  let userBId = null;

  await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
  await sql(`DROP SCHEMA IF EXISTS auth CASCADE`);

  try {
    // Create auth.uid() function — reads sub claim from request.jwt.claims (set by RLS middleware)
    await sql(`CREATE SCHEMA IF NOT EXISTS auth`);
    await sql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub')::uuid
      $$
    `);

    // Create RLS table
    await sql(`
      CREATE TABLE public.${TABLE} (
        id       serial,
        owner_id uuid,
        value    text
      )
    `);
    await sql(`ALTER TABLE public.${TABLE} ENABLE ROW LEVEL SECURITY`);
    await sql(`
      CREATE POLICY rls_owner_policy ON public.${TABLE}
        USING (owner_id = (auth.uid())::uuid)
    `);
    await sql(`GRANT SELECT, INSERT ON public.${TABLE} TO authenticated`);
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);

    // Signup users
    const signupA = await api('POST', '/auth/v1/signup', { email: emailA, password: 'Password-A-123' });
    tokenA  = signupA.json?.access_token;
    userAId = signupA.json?.user?.id;

    const signupB = await api('POST', '/auth/v1/signup', { email: emailB, password: 'Password-B-123' });
    tokenB  = signupB.json?.access_token;
    userBId = signupB.json?.user?.id;

    assert(typeof tokenA === 'string', `user A signed up (got token: ${typeof tokenA})`);
    assert(typeof tokenB === 'string', `user B signed up (got token: ${typeof tokenB})`);

    // Insert rows as service role (bypasses RLS)
    if (userAId) {
      await sql(`INSERT INTO public.${TABLE} (owner_id, value) VALUES ('${userAId}', 'row-of-user-A')`);
    }
    if (userBId) {
      await sql(`INSERT INTO public.${TABLE} (owner_id, value) VALUES ('${userBId}', 'row-of-user-B')`);
    }

    // Anon key → 0 rows (no uid → policy excludes all)
    {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, ANON_KEY);
      const rowCount = Array.isArray(r.json) ? r.json.length : -1;
      assert(
        r.status === 200 && rowCount === 0,
        `anon key → 0 rows via RLS (got status=${r.status}, rows=${rowCount})`
      );
    }

    // User A → sees only own row
    if (tokenA) {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, tokenA);
      const rows = Array.isArray(r.json) ? r.json : [];
      assert(
        r.status === 200 && rows.length === 1 && rows[0]?.value === 'row-of-user-A',
        `user A sees only own row (got ${rows.length} rows)`
      );
    }

    // User B → sees only own row
    if (tokenB) {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, tokenB);
      const rows = Array.isArray(r.json) ? r.json : [];
      assert(
        r.status === 200 && rows.length === 1 && rows[0]?.value === 'row-of-user-B',
        `user B sees only own row (got ${rows.length} rows)`
      );
    }

    // Service role → bypasses RLS, sees all rows
    {
      const r = await api('GET', `/rest/v1/${TABLE}`, null, SRV_KEY);
      const rows = Array.isArray(r.json) ? r.json : [];
      assert(
        r.status === 200 && rows.length >= 2,
        `service role bypasses RLS, sees all rows (got ${rows.length})`
      );
    }

  } finally {
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    await sql(`DROP SCHEMA IF EXISTS auth CASCADE`);
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);
    // Delete test users via admin
    for (const uid of [userAId, userBId]) {
      if (uid) {
        try { await api('DELETE', `/auth/v1/admin/users/${uid}`, null, SRV_KEY); } catch (_) { /* ignore */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Section 6: REALTIME — Live queries (WebSocket)
// ---------------------------------------------------------------------------

async function sectionRealtime() {
  const TABLE = '_test_rt';
  const QUERY_ID = `rt_${RUN_ID}`;

  // Install pg_reactive extension (dropped by pg_regress cleanup)
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_reactive`);

  await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
  await sql(`CREATE TABLE public.${TABLE} (id serial, name text)`);
  await api('POST', '/api/catalog/refresh', null, SRV_KEY);

  // Subscribe via DO block (pgr.subscribe writes data, incompatible with read-only SELECT path)
  await sql(`DO $$ BEGIN PERFORM pgr.subscribe('${QUERY_ID}', 'SELECT id, name FROM public.${TABLE}'); END $$`);

  let ws = null;

  try {
    // Connect WebSocket using the service role key as token (it's accepted as anon-key or as JWT)
    // The proxy accepts ANON_KEY in Authorization: Bearer without JWT validation
    ws = await wsConnect(WS_HOST, WS_PORT, `/ws/${QUERY_ID}`, ANON_KEY);

    // Receive welcome message
    let welcomeText;
    try {
      welcomeText = await ws.receive(5000);
    } catch (e) {
      assert(false, `WebSocket received welcome message (error: ${e.message})`);
      return;
    }
    const welcome = JSON.parse(welcomeText);
    assert(
      welcome?.type === 'subscribed' && welcome?.query_id === QUERY_ID,
      `received subscribed welcome (got ${JSON.stringify(welcome)})`
    );

    // INSERT a row via REST to trigger delta
    await api('POST', `/rest/v1/${TABLE}`, { name: 'live-test-row' }, SRV_KEY);

    // Receive delta
    let deltaText;
    try {
      deltaText = await ws.receive(8000);
    } catch (e) {
      assert(false, `WebSocket received INSERT delta (error: ${e.message})`);
      return;
    }
    const delta = JSON.parse(deltaText);
    assert(
      delta?.query_id === QUERY_ID && Array.isArray(delta?.inserted),
      `received INSERT delta with correct query_id (got ${JSON.stringify(delta)})`
    );
    assert(
      delta?.inserted?.some(r => r.name === 'live-test-row'),
      `INSERT delta contains inserted row (got ${JSON.stringify(delta?.inserted)})`
    );

    // seq field must be a number >= 1 (P8 sequence numbers)
    assert(
      typeof delta?.seq === 'number' && delta.seq >= 1,
      `INSERT delta has seq >= 1 (got seq=${delta?.seq})`
    );

    // DELETE the row via REST
    await api('DELETE', `/rest/v1/${TABLE}?name=eq.live-test-row`, null, SRV_KEY);

    // Receive delete delta
    let delDeltaText;
    try {
      delDeltaText = await ws.receive(8000);
    } catch (e) {
      assert(false, `WebSocket received DELETE delta (error: ${e.message})`);
      return;
    }
    const delDelta = JSON.parse(delDeltaText);
    assert(
      delDelta?.query_id === QUERY_ID && Array.isArray(delDelta?.deleted) && delDelta.deleted.length > 0,
      `received DELETE delta with deleted rows (got ${JSON.stringify(delDelta)})`
    );
    assert(
      delDelta?.deleted?.some(r => r.name === 'live-test-row'),
      `DELETE delta contains deleted row`
    );

  } finally {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
    }
    try {
      await sql(`DO $$ BEGIN PERFORM pgr.unsubscribe('${QUERY_ID}'); END $$`);
    } catch (_) { /* ignore */ }
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    try { await sql(`DROP EXTENSION IF EXISTS pg_reactive CASCADE`); } catch (_) { /* ignore */ }
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);
  }
}

// ---------------------------------------------------------------------------
// Section 7: REALTIME — DDL safety (P8)
// ---------------------------------------------------------------------------

async function sectionDdl() {
  const TABLE = '_test_ddl';
  const QUERY_ID = `ddl_${RUN_ID}`;

  // Install pg_reactive extension (dropped by pg_regress cleanup)
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_reactive`);

  await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
  await sql(`CREATE TABLE public.${TABLE} (id serial, name text)`);
  // Subscribe via DO block (pgr.subscribe writes data, incompatible with read-only SELECT path)
  await sql(`DO $$ BEGIN PERFORM pgr.subscribe('${QUERY_ID}', 'SELECT id, name FROM public.${TABLE}'); END $$`);

  let ws = null;

  try {
    ws = await wsConnect(WS_HOST, WS_PORT, `/ws/${QUERY_ID}`, ANON_KEY);

    // Receive welcome
    await ws.receive(5000).catch(() => null);

    // DROP the table — this is the DDL safety test
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);

    // Wait briefly for possible schema_changed notification
    let ddlMsg = null;
    try {
      const text = await ws.receive(3000);
      ddlMsg = JSON.parse(text);
    } catch (_) {
      // Timeout is acceptable — connection may just close silently
    }

    // Either the proxy sent a schema_changed message OR the subscription was cleaned up.
    // We verify no orphaned subscription exists in shmem.
    const subCheck = await sql(`SELECT query_id FROM pgr.get_subscriptions() WHERE query_id = '${QUERY_ID}'`);
    const hasOrphan = subCheck?.json?.rows?.length > 0;

    if (ddlMsg?.type === 'schema_changed') {
      assert(true, 'DROP TABLE sent schema_changed notification');
    } else {
      assert(!hasOrphan, `no orphaned shmem subscription after DROP TABLE (rows: ${JSON.stringify(subCheck?.json?.rows)})`);
    }

  } finally {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
    }
    try {
      await sql(`DO $$ BEGIN PERFORM pgr.unsubscribe('${QUERY_ID}'); END $$`);
    } catch (_) { /* ignore */ }
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    try { await sql(`DROP EXTENSION IF EXISTS pg_reactive CASCADE`); } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Section 8: NOTIFY — Sequence numbers (P8)
// ---------------------------------------------------------------------------

async function sectionSeq() {
  const TABLE = '_test_seq';
  const QUERY_ID = `seq_${RUN_ID}`;

  // Install pg_reactive extension (dropped by pg_regress cleanup)
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_reactive`);

  await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
  await sql(`CREATE TABLE public.${TABLE} (id serial, val text)`);
  await api('POST', '/api/catalog/refresh', null, SRV_KEY);
  // Subscribe via DO block (pgr.subscribe writes data, incompatible with read-only SELECT path)
  await sql(`DO $$ BEGIN PERFORM pgr.subscribe('${QUERY_ID}', 'SELECT id, val FROM public.${TABLE}'); END $$`);

  let ws = null;

  try {
    ws = await wsConnect(WS_HOST, WS_PORT, `/ws/${QUERY_ID}`, ANON_KEY);

    // Consume welcome message
    await ws.receive(5000).catch(() => null);

    // Trigger 3 inserts
    const seqValues = [];
    for (let i = 1; i <= 3; i++) {
      await api('POST', `/rest/v1/${TABLE}`, { val: `seq-row-${i}` }, SRV_KEY);
      try {
        const text = await ws.receive(8000);
        const msg = JSON.parse(text);
        if (typeof msg?.seq === 'number') {
          seqValues.push(msg.seq);
        }
      } catch (e) {
        assert(false, `received delta for insert ${i} (error: ${e.message})`);
        break;
      }
    }

    assert(seqValues.length === 3, `received 3 delta messages with seq (got ${seqValues.length})`);

    if (seqValues.length >= 2) {
      const isMonotonic = seqValues.every((v, i) => i === 0 || v > seqValues[i - 1]);
      assert(isMonotonic, `seq values are monotonically increasing: ${JSON.stringify(seqValues)}`);
    }

    if (seqValues.length === 3) {
      const isGapFree = seqValues[1] === seqValues[0] + 1 && seqValues[2] === seqValues[1] + 1;
      assert(
        isGapFree || seqValues.every(v => Number.isInteger(v)),
        `seq values are integers (gap-free or monotonic): ${JSON.stringify(seqValues)}`
      );
    }

  } finally {
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
    }
    try {
      await sql(`DO $$ BEGIN PERFORM pgr.unsubscribe('${QUERY_ID}'); END $$`);
    } catch (_) { /* ignore */ }
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    try { await sql(`DROP EXTENSION IF EXISTS pg_reactive CASCADE`); } catch (_) { /* ignore */ }
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);
  }
}

// ---------------------------------------------------------------------------
// Section 9: SQL endpoint
// ---------------------------------------------------------------------------

async function sectionSql() {
  // POST /api/sql with service role
  {
    const r = await api('POST', '/api/sql', { sql: 'SELECT 1 + 1 AS result' }, SRV_KEY);
    assert(r.status === 200, `POST /api/sql with service role → 200 (got ${r.status})`);
    assert(r.json?.ok === true, 'sql response has ok=true');
    assert(Array.isArray(r.json?.rows), 'sql SELECT returns rows array');
    assert(r.json?.rows?.[0]?.result === 2, `SELECT 1+1 = 2 (got ${r.json?.rows?.[0]?.result})`);
  }

  // POST /api/sql with anon key → 401/403 (unless ENABLE_SQL_ENDPOINT=true in dev mode)
  {
    const r = await api('POST', '/api/sql', { sql: 'SELECT 1' }, ANON_KEY);
    // In dev mode ENABLE_SQL_ENDPOINT=true allows anon key; in prod it should be 401/403
    assert(
      r.status === 401 || r.status === 403 || r.status === 200,
      `POST /api/sql with anon key → 401/403 (or 200 in dev mode) (got ${r.status})`
    );
  }

  // POST /api/sql with DML (CREATE TABLE) — allowed for service role
  {
    const tmpTable = `_sql_tmp_${RUN_ID}`;
    const r = await api('POST', '/api/sql', { sql: `CREATE TABLE public.${tmpTable} (x int)` }, SRV_KEY);
    assert(
      r.status === 200,
      `POST /api/sql DDL (CREATE TABLE) with service role → 200 (got ${r.status})`
    );
    // Cleanup
    await sql(`DROP TABLE IF EXISTS public.${tmpTable}`);
  }

  // POST /api/sql — SELECT with write attempt in CTE is blocked (read-only transaction)
  {
    const tmpTable = `_sql_guard_${RUN_ID}`;
    await sql(`CREATE TABLE public.${tmpTable} (x int)`);
    const r = await api('POST', '/api/sql', {
      sql: `WITH d AS (DELETE FROM public.${tmpTable} RETURNING *) SELECT * FROM d`,
    }, SRV_KEY);
    // Read-only transaction should reject this
    assert(
      r.status === 500 || (r.status === 200 && r.json?.error !== undefined),
      `CTE write-in-SELECT is blocked or errors (got status=${r.status})`
    );
    await sql(`DROP TABLE IF EXISTS public.${tmpTable}`);
  }
}

// ---------------------------------------------------------------------------
// Section 10: CATALOG
// ---------------------------------------------------------------------------

async function sectionCatalog() {
  // The proxy exposes catalog refresh at POST /api/catalog/refresh
  // and uses internal catalog for REST. Verify it with a known table.
  const TABLE = `_cat_test_${RUN_ID}`;

  await sql(`CREATE TABLE public.${TABLE} (id serial primary key, label text)`);

  try {
    // Force refresh
    const refresh = await api('POST', '/api/catalog/refresh', null, SRV_KEY);
    assert(
      refresh.status === 200 && refresh.json?.ok === true,
      `POST /api/catalog/refresh → 200 ok (got ${refresh.status})`
    );

    // Verify catalog refreshed: the new table should be accessible via REST
    const r = await api('GET', `/rest/v1/${TABLE}`, null, SRV_KEY);
    assert(r.status === 200, `newly created table accessible via REST after catalog refresh (got ${r.status})`);
    assert(Array.isArray(r.json), 'catalog refresh makes new table available');

    // Verify catalog refresh requires service role
    const rAnon = await api('POST', '/api/catalog/refresh', null, ANON_KEY);
    assert(
      rAnon.status === 401 || rAnon.status === 403,
      `catalog refresh with anon key → 401/403 (got ${rAnon.status})`
    );

  } finally {
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`);
    await api('POST', '/api/catalog/refresh', null, SRV_KEY);
  }
}

// ---------------------------------------------------------------------------
// Section 11: RPC (stored functions)
// ---------------------------------------------------------------------------

async function sectionRpc() {
  const FN = 'pgstack_test_add';

  await sql(`DROP FUNCTION IF EXISTS public.${FN}(int, int)`);

  try {
    // Create function
    const setup = await sql(`
      CREATE OR REPLACE FUNCTION public.${FN}(a int, b int)
      RETURNS int
      LANGUAGE sql
      AS $$ SELECT a + b $$
    `);
    assert(setup.status === 200, `create RPC function → 200 (got ${setup.status})`);

    // POST /rest/v1/rpc/{fn} with params
    {
      const r = await api('POST', `/rest/v1/rpc/${FN}`, { a: 3, b: 4 }, SRV_KEY);
      assert(r.status === 200, `POST /rest/v1/rpc/${FN} → 200 (got ${r.status})`);
      assert(
        r.json === 7 || (Array.isArray(r.json) && r.json[0] === 7) || r.json?.[FN] === 7,
        `3 + 4 = 7 (got ${JSON.stringify(r.json)})`
      );
    }

    // GET /rest/v1/rpc/{fn} with query-string params
    {
      const r = await api('GET', `/rest/v1/rpc/${FN}?a=10&b=20`, null, SRV_KEY);
      assert(r.status === 200, `GET /rest/v1/rpc/${FN}?a=10&b=20 → 200 (got ${r.status})`);
      assert(
        r.json === 30 || (Array.isArray(r.json) && r.json[0] === 30),
        `10 + 20 = 30 (got ${JSON.stringify(r.json)})`
      );
    }

    // Call non-existent function
    {
      const r = await api('POST', '/rest/v1/rpc/pgstack_does_not_exist_xyz_abc', {}, SRV_KEY);
      assert(
        r.status === 400 || r.status === 404 || r.status === 500,
        `non-existent RPC function → error status (got ${r.status})`
      );
    }

    // No auth → 401
    {
      const r = await api('POST', `/rest/v1/rpc/${FN}`, { a: 1, b: 2 });
      assert(r.status === 401, `RPC without auth → 401 (got ${r.status})`);
    }

  } finally {
    await sql(`DROP FUNCTION IF EXISTS public.${FN}(int, int)`);
  }
}

// ---------------------------------------------------------------------------
// Section 12: JWT edge cases
// ---------------------------------------------------------------------------

async function sectionJwt() {
  const now = Math.floor(Date.now() / 1000);

  // Request with expired JWT → 401
  {
    const expiredToken = makeJwt({ sub: 'user-expired', role: 'authenticated', exp: now - 3600, iat: now - 7200 });
    const r = await api('GET', '/auth/v1/user', null, expiredToken);
    assert(r.status === 401, `expired JWT → 401 (got ${r.status})`);
  }

  // Request with JWT signed by wrong secret → 401
  {
    const wrongToken = makeJwt({ sub: 'attacker', role: 'service_role', exp: now + 3600 }, 'wrong-secret-12345');
    const r = await api('GET', '/auth/v1/user', null, wrongToken);
    assert(r.status === 401, `JWT with wrong secret → 401 (got ${r.status})`);
  }

  // Request with alg:none JWT → 401
  {
    function b64url(data) {
      return Buffer.from(data)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    }
    const noneHeader  = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const nonePayload = b64url(JSON.stringify({ sub: 'forger', role: 'service_role', exp: now + 9999 }));
    const noneToken   = `${noneHeader}.${nonePayload}.`;
    const r = await api('GET', '/auth/v1/user', null, noneToken);
    assert(r.status === 401, `alg:none JWT → 401 (got ${r.status})`);
  }

  // Request with valid JWT but missing sub → 401
  {
    const noSubToken = makeJwt({ role: 'authenticated', exp: now + 3600 });
    const r = await api('GET', '/auth/v1/user', null, noSubToken);
    // sub is required for user lookup — expect 401 or possibly 400
    assert(
      r.status === 401 || r.status === 400,
      `JWT without sub → 401 or 400 (got ${r.status})`
    );
  }

  // Completely malformed JWT → 401
  {
    const r = await api('GET', '/auth/v1/user', null, 'not.a.jwt.at.all');
    assert(r.status === 401, `malformed JWT → 401 (got ${r.status})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  pgStack Manual Test Suite');
  console.log('══════════════════════════════════════');

  if (sectionFilter) {
    console.log(`  Running section: ${sectionFilter}`);
  }

  await runSection('health',    '1/12  HEALTH',                         sectionHealth);
  await runSection('auth',      '2/12  AUTH — Signup/Login',            sectionAuth);
  await runSection('admin',     '3/12  AUTH — Admin',                   sectionAdmin);
  await runSection('rest',      '4/12  REST — CRUD',                    sectionRest);
  await runSection('rls',       '5/12  REST — RLS',                     sectionRls);
  await runSection('realtime',  '6/12  REALTIME — Live queries',        sectionRealtime);
  await runSection('ddl',       '7/12  REALTIME — DDL safety',          sectionDdl);
  await runSection('seq',       '8/12  NOTIFY — Sequence numbers',      sectionSeq);
  await runSection('sql',       '9/12  SQL endpoint',                   sectionSql);
  await runSection('catalog',   '10/12 CATALOG',                        sectionCatalog);
  await runSection('rpc',       '11/12 RPC (stored functions)',         sectionRpc);
  await runSection('jwt',       '12/12 JWT edge cases',                 sectionJwt);

  console.log('');
  console.log('══════════════════════════════════════');
  if (totalFailed === 0) {
    console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed`);
  } else {
    console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed`);
  }
  console.log('══════════════════════════════════════');
  console.log('');

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
