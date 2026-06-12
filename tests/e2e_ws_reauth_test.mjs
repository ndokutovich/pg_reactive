/**
 * E2E: an OPEN WebSocket must lose access when the subscription's audience
 * changes out from under it (round 39 F1, HIGH).
 *
 * The handshake gate (ws.go) only authorizes at connect time. If a live
 * subscription is later re-registered with a stricter/different audience, a
 * still-open connection that was authorized under the OLD audience must stop
 * receiving deltas and be disconnected — otherwise:
 *   - public -> private: an anon socket keeps reading a now-private query;
 *   - tenant A -> tenant B: tenant A keeps reading tenant B's rows.
 *
 * Requires: proxy on 127.0.0.1:8080 with JWT_SECRET set (docker compose dev).
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import crypto from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { psql } from './helpers.mjs';

const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const URL = 'ws://127.0.0.1:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret-do-not-use-in-production';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function jwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a WS, collect text messages, track close. Resolves once "subscribed".
function connect(queryID, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}/ws/${queryID}?${query}`);
    const messages = [];
    let closed = false;
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('close', () => { closed = true; });
    ws.on('error', () => {}); // close is what we assert on
    ws.on('open', () => {});
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${queryID}`)), 4000);
    ws.on('message', (d) => {
      if (d.toString().includes('"subscribed"')) { clearTimeout(t); resolve({ ws, messages, isClosed: () => closed }); }
    });
  });
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); } else { console.error(`  ✗ ${msg}`); failures++; }
}

async function scenario(name, { setupAudience, newAudience, connectQuery }) {
  console.log(`\n=== ${name} ===`);
  const qid = 'reauth_probe';
  psql(`SELECT pgr.unsubscribe('${qid}');`);
  psql(`DROP TABLE IF EXISTS reauth_probe_t CASCADE;`);
  psql(`CREATE TABLE reauth_probe_t (id int primary key, secret text);`);
  psql(`SELECT pgr.subscribe('${qid}','SELECT id, secret FROM reauth_probe_t','delta',${setupAudience});`);

  const { ws, messages, isClosed } = await connect(qid, connectQuery);

  // Re-register the SAME query under a different audience, then write a secret.
  psql(`SELECT pgr.subscribe('${qid}','SELECT id, secret FROM reauth_probe_t','delta',${newAudience});`);
  await sleep(200);
  psql(`INSERT INTO reauth_probe_t (id, secret) VALUES (1, 'TOP_SECRET');`);

  await sleep(1500); // give any (buggy) delta time to arrive

  const leaked = messages.some((m) => m.includes('TOP_SECRET'));
  check(!leaked, 'old connection did NOT receive the post-reauth secret row');
  check(isClosed(), 'old connection was disconnected after the audience change');

  try { ws.close(); } catch {}
  psql(`SELECT pgr.unsubscribe('${qid}');`);
  psql(`DROP TABLE IF EXISTS reauth_probe_t CASCADE;`);
}

// tenant A -> tenant B: authorized as A, audience flips to B.
await scenario('tenant A -> tenant B', {
  setupAudience: `jsonb_build_object('sub','tenantA')`,
  newAudience: `jsonb_build_object('sub','tenantB')`,
  connectQuery: `token=${jwt({ sub: 'tenantA', role: 'authenticated' })}`,
});

// public -> private: anon on a public query, audience flips to private.
await scenario('public -> private', {
  setupAudience: `NULL`,
  newAudience: `jsonb_build_object('sub','victim')`,
  connectQuery: `apikey=${ANON_KEY}`,
});

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — stale WebSocket retained access after audience change.`);
  process.exit(1);
}
console.log('\nPASS: open WebSockets are re-authorized and disconnected on audience change.');
