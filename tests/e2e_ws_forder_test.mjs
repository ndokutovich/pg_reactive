/**
 * E2E: F-ORDER (round 39 batch-2, HIGH) — a delta computed from a re-registered
 * subscription must not reach an old-epoch connection EVEN in the window before
 * the re-subscribe transaction commits.
 *
 * The leak the generation model must close: pgr.subscribe mutates the shared-
 * memory query/generation NON-transactionally (visible the instant the LWLock
 * is released), but the 'resubscribed' revocation NOTIFY is only delivered when
 * the subscribe transaction COMMITS. So a concurrent DML that commits inside the
 * [_subscribe_internal, COMMIT] window emits a NEW-epoch delta that is queued
 * BEFORE 'resubscribed'. With a commit-ordering-only defense the old connection
 * receives it before being revoked. The fix stamps the shmem generation into
 * every NOTIFY and the proxy delivers a delta only to connections bound to that
 * exact generation — so the new-epoch delta is dropped for the old connection
 * regardless of ordering.
 *
 * Repro: hold the re-subscribe in an OPEN transaction (pg_sleep) so 'resubscribed'
 * is not delivered, commit a DML from a SEPARATE backend during that window, and
 * assert the still-connected anon socket never sees the row.
 *
 * Requires: proxy on 127.0.0.1:8080 with JWT_SECRET set (docker compose dev).
 */
import { execFileSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { psql } from './helpers.mjs';

const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const URL = process.env.WS_BASE || 'ws://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fire a SQL script in its own backend WITHOUT blocking (used to hold a tx open).
// REJECTS on a non-zero exit so a failed attack transaction cannot make the test
// falsely pass (the secret simply never appears) — the caller must surface it.
function psqlAsync(sql) {
  const child = spawn(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`background psql exited ${code}: ${stderr.trim()}`));
    });
  });
}

function connect(queryID, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}/ws/${queryID}?${query}`);
    const messages = [];
    let closed = false;
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('close', () => { closed = true; });
    ws.on('error', () => {});
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${queryID}`)), 4000);
    ws.on('message', (d) => {
      if (d.toString().includes('"subscribed"')) { clearTimeout(t); resolve({ ws, messages, isClosed: () => closed }); }
    });
  });
}

let failures = 0;
const check = (cond, msg) => { cond ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), failures++); };

console.log('\n=== F-ORDER: new-epoch delta in the pre-commit window must not leak ===');

const qid = 'forder_probe';
const q = 'SELECT id, secret FROM forder_probe_t';
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS forder_probe_t CASCADE;`);
psql(`CREATE TABLE forder_probe_t (id int primary key, secret text);`);
// Public subscription; anon is authorized.
psql(`SELECT pgr.subscribe('${qid}','${q}','delta',NULL);`);

const { ws, messages, isClosed } = await connect(qid, `apikey=${ANON_KEY}`);

// Hold the re-registration (public -> private) in an OPEN transaction: shmem
// flips to the new generation immediately, but 'resubscribed' is not delivered
// until COMMIT — so the anon is NOT yet revoked during pg_sleep.
let txError = null;
const txDone = psqlAsync(
  `BEGIN; SELECT pgr.subscribe('${qid}','${q}','delta',jsonb_build_object('sub','victim')); SELECT pg_sleep(3); COMMIT;`
).catch((e) => { txError = e; });

await sleep(800); // let the re-subscribe execute (shmem now at the new generation)

// Commit a DML from a SEPARATE backend INSIDE the open window. Its recompute
// reads the new shmem generation and emits a delta stamped with it.
psql(`INSERT INTO forder_probe_t (id, secret) VALUES (1, 'TOP_SECRET');`);

await sleep(1200); // a buggy build would have delivered the delta by now

const leakedDuringWindow = messages.some((m) => m.includes('TOP_SECRET'));
check(!leakedDuringWindow, 'anon did NOT receive the new-epoch row in the pre-commit window');

await txDone;        // tx commits -> 'resubscribed' -> RevokeStale
// The attack is only meaningful if it actually committed. Surface a failed
// background transaction and confirm the re-subscribe took effect, so a green
// result cannot come from the secret never having been written (finding 2).
check(!txError, `re-subscribe transaction committed cleanly${txError ? ' — ' + txError.message : ''}`);
const audAfter = psql(`SELECT audience::text FROM pgr.subscription_meta('${qid}');`).trim();
check(audAfter.includes('victim'), `re-subscribe actually took effect (audience now ${audAfter || 'EMPTY'})`);
await sleep(800);
check(isClosed(), 'anon was disconnected once the re-subscribe committed');
const leakedEver = messages.some((m) => m.includes('TOP_SECRET'));
check(!leakedEver, 'anon never received the new-epoch row at all');

try { ws.close(); } catch {}
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS forder_probe_t CASCADE;`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — F-ORDER leak: an old-epoch socket saw a new-epoch delta.`);
  process.exit(1);
}
console.log('\nPASS: a new-epoch delta in the non-transactional pre-commit window is dropped for the old generation.');
