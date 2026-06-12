/**
 * E2E: snapshot TOCTOU (round 39 batch-2, HIGH) — the generation check and the
 * snapshot row read must observe ONE consistent database state, so a re-subscribe
 * committing between them cannot let an old-generation connection read the new
 * epoch's rows.
 *
 * snapshotForGeneration ran the gen check and the row read as two statements in
 * a READ COMMITTED transaction — each takes a fresh snapshot. Deterministic
 * repro: hold ACCESS EXCLUSIVE on the snapshot table so the connection's row
 * read blocks; meanwhile, in that same locking transaction, re-subscribe the
 * query_id to a private tenant-B query (bumping the generation and rebuilding
 * the snapshot); commit. Pre-fix the blocked read resumes and returns the
 * tenant-B rows while the gen check already passed on the old generation — the
 * anon receives SECRET_B. The fix reads under REPEATABLE READ and takes
 * ACCESS SHARE on the snapshot table up front, so the gen check and the rows
 * are consistent and the connection closes on the generation change instead.
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

const URL = 'ws://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// REJECTS on a non-zero exit so a failed locking/re-subscribe transaction cannot
// make the test falsely pass (the secret simply never appears) — finding 2.
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
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${queryID}`)), 5000);
    ws.on('message', (d) => {
      if (d.toString().includes('"subscribed"')) { clearTimeout(t); resolve({ ws, messages, isClosed: () => closed }); }
    });
  });
}

let failures = 0;
const check = (cond, msg) => { cond ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), failures++); };

console.log('\n=== snapshot TOCTOU: gen check and row read must be one consistent snapshot ===');

const qid = 'toctou_q';
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS toctou_t CASCADE;`);
psql(`CREATE TABLE toctou_t (id int primary key, tenant text, secret text);`);
psql(`INSERT INTO toctou_t VALUES (1,'pub','PUB_ROW'),(2,'B','SECRET_B');`);
// Public subscription; snapshot holds only the public row. anon is authorized.
psql(`SELECT pgr.subscribe('${qid}','SELECT id, secret FROM toctou_t WHERE tenant=''pub''','delta',NULL);`);
await sleep(200);

// Locking transaction: hold ACCESS EXCLUSIVE on the snapshot table so the
// connection's row read blocks, then re-point the query_id to a private
// tenant-B query (bumps generation + rebuilds snapshot) and commit.
let txError = null;
const txDone = psqlAsync(
  `BEGIN;
   LOCK TABLE pgr."_snap_${qid}" IN ACCESS EXCLUSIVE MODE;
   SELECT pg_sleep(2);
   SELECT pgr.subscribe('${qid}','SELECT id, secret FROM toctou_t WHERE tenant=''B''','delta',jsonb_build_object('sub','tenantB'));
   COMMIT;`
).catch((e) => { txError = e; });

await sleep(500); // let the lock be held before anon connects

// anon connects while the query is still public (committed). Its snapshot row
// read blocks on the locked table and straddles the re-subscribe commit.
const { ws, messages } = await connect(qid, `apikey=${ANON_KEY}`);

await txDone;        // lock releases, re-subscribe commits, blocked read resumes
// The TOCTOU only exists if the locking + re-subscribe transaction committed.
// Surface a failed background tx and confirm the re-point took effect, so a
// green result cannot come from the attack never having run (finding 2).
check(!txError, `locking/re-subscribe transaction committed cleanly${txError ? ' — ' + txError.message : ''}`);
const audAfter = psql(`SELECT audience::text FROM pgr.subscription_meta('${qid}');`).trim();
check(audAfter.includes('tenantB'), `re-subscribe actually took effect (audience now ${audAfter || 'EMPTY'})`);
await sleep(1000);

const leaked = messages.some((m) => m.includes('SECRET_B'));
check(!leaked, 'anon did NOT receive the private tenant-B snapshot row across the re-subscribe');

try { ws.close(); } catch {}
psql(`SELECT pgr.unsubscribe('${qid}');`);
psql(`DROP TABLE IF EXISTS toctou_t CASCADE;`);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} assertion(s) — snapshot TOCTOU: gen check passed on the old epoch while rows came from the new one.`);
  process.exit(1);
}
console.log('\nPASS: the snapshot read is consistent with its generation check; no cross-epoch leak.');
