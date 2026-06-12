/**
 * E2E: F-SNAP (round 39 batch-2) — re-registering a query_id to a DIFFERENT
 * query must rebuild the snapshot, so a fresh connection on the new epoch never
 * reads the previous query's rows in its initial snapshot.
 *
 * pgr_snapshot_create uses CREATE UNLOGGED TABLE IF NOT EXISTS, so before the
 * fix a re-subscribe that repointed an existing query_id to a different query
 * left pgr._snap_<id> holding the OLD query's rows. A client authorized for the
 * NEW audience then received those old rows via the initial snapshot — and the
 * generation matched (the re-subscribe bumped both), so the proxy's generation
 * gate could not catch it: a cross-tenant leak through the snapshot, distinct
 * from the delta path. The fix drops the snapshot on every (re-)subscribe.
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

function connect(queryID, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}/ws/${queryID}?${query}`);
    const messages = [];
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('error', () => {});
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${queryID}`)), 4000);
    ws.on('message', (d) => {
      if (d.toString().includes('"subscribed"')) { clearTimeout(t); resolve({ ws, messages }); }
    });
  });
}

let failures = 0;
const check = (cond, msg) => { cond ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), failures++); };

console.log('\n=== F-SNAP: re-subscribe to a different query rebuilds the snapshot ===');

const qid = 'snap_probe';
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS snap_probe_t CASCADE;`);
psql(`CREATE TABLE snap_probe_t (id int primary key, tenant text, secret text);`);
psql(`INSERT INTO snap_probe_t VALUES (1,'A','SECRET_A'),(2,'B','SECRET_B');`);

// Subscribe the id to tenant A's query (builds _snap_snap_probe with SECRET_A).
psql(`SELECT pgr.subscribe('${qid}','SELECT id, secret FROM snap_probe_t WHERE tenant=''A''','delta',jsonb_build_object('sub','tenantA'));`);
await sleep(200);

// Re-register the SAME id to tenant B's query — DIFFERENT query, no unsubscribe.
psql(`SELECT pgr.subscribe('${qid}','SELECT id, secret FROM snap_probe_t WHERE tenant=''B''','delta',jsonb_build_object('sub','tenantB'));`);
await sleep(200);

// A fresh tenant-B client connects and receives its initial snapshot.
const { ws, messages } = await connect(qid, `token=${jwt({ sub: 'tenantB', role: 'authenticated' })}`);
await sleep(800);

const all = messages.join('\n');
check(!all.includes('SECRET_A'), 'fresh tenant-B client did NOT receive tenant-A rows in its snapshot');
check(all.includes('SECRET_B'), 'fresh tenant-B client received its own (tenant-B) snapshot rows');

try { ws.close(); } catch {}
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS snap_probe_t CASCADE;`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — F-SNAP: a stale snapshot leaked the previous query's rows.`);
  process.exit(1);
}
console.log('\nPASS: a query-changing re-subscribe rebuilds the snapshot; no stale rows leak.');
