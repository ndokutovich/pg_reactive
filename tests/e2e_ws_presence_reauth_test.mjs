/**
 * E2E: presence / client-broadcast must NOT reach a connection whose
 * subscription audience changed out from under it — even with no DML delta
 * (round 39 batch-2 F2, HIGH).
 *
 * Hub.Broadcast (presence + client broadcast) bypassed re-authorization, and a
 * stale socket was only revoked on the NEXT pg delta. So: anon on a public
 * query, the query is re-registered private (no DML), an authorized peer sends
 * a broadcast, and the stale anon receives it.
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

function b64url(s) { return Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pl = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...p }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pl}`).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${h}.${pl}.${sig}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(qid, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}/ws/${qid}?${query}`);
    const messages = [];
    let closed = false;
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('close', () => { closed = true; });
    ws.on('error', () => {});
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${qid}`)), 4000);
    ws.on('message', (d) => { if (d.toString().includes('"subscribed"')) { clearTimeout(t); resolve({ ws, messages, isClosed: () => closed }); } });
  });
}

let failures = 0;
const check = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.error(`  ✗ ${m}`); failures++; } };

const qid = 'presence_reauth_probe';
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS presence_reauth_t CASCADE;`);
psql(`CREATE TABLE presence_reauth_t (id int primary key);`);
psql(`SELECT pgr.subscribe('${qid}','SELECT id FROM presence_reauth_t','delta',NULL);`); // public

console.log('=== presence/broadcast must not reach a stale anon after re-subscribe (no DML) ===');
const anon = await connect(qid, `apikey=${ANON_KEY}`);

// Re-register PRIVATE — no DML, so no delta fires.
psql(`SELECT pgr.subscribe('${qid}','SELECT id FROM presence_reauth_t','delta',jsonb_build_object('sub','victim'));`);
await sleep(400); // let the resubscribe propagate

// An authorized peer connects and broadcasts a secret.
const victim = await connect(qid, `token=${jwt({ sub: 'victim', role: 'authenticated' })}`);
victim.ws.send(JSON.stringify({ type: 'broadcast', payload: { secret: 'PRESENCE_CHANNEL_SECRET' } }));
await sleep(1000);

const leaked = anon.messages.some((m) => m.includes('PRESENCE_CHANNEL_SECRET'));
check(!leaked, 'stale anon did NOT receive the peer broadcast after the query went private');
check(anon.isClosed(), 'stale anon was disconnected by the audience change (no DML needed)');

try { anon.ws.close(); victim.ws.close(); } catch {}
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS presence_reauth_t CASCADE;`);

if (failures > 0) { console.error(`\nFAIL: ${failures} — presence/broadcast bypassed re-authorization.`); process.exit(1); }
console.log('\nPASS: presence/broadcast is generation-gated and stale sockets are revoked without a delta.');
