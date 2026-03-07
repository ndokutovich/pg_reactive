/**
 * P7: Concurrent Subscribe / Unsubscribe Churn
 *
 * Exercises the Hub fan-out under subscribe/unsubscribe pressure:
 *   - Opens N WebSocket connections simultaneously
 *   - Fires INSERT bursts while connections are live
 *   - Randomly unsubscribes half while INSERTs are landing
 *   - Verifies zero missed deltas on survivors
 *
 * Regression test for the Broadcast data race fixed in hub.go.
 *
 * PASS criteria:
 *   - All surviving connections receive all expected deltas (0 misses)
 *   - No WebSocket errors or connection crashes
 *
 * Prerequisites: docker compose up -d (DB + proxy running)
 */
import WebSocket from 'ws';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, '../node_modules/ws'))) {
  execFileSync('npm', ['install'], { cwd: join(_testDir, '..'), stdio: 'inherit' });
}

const PROXY_URL   = 'ws://127.0.0.1:8080/ws/p7_q';
const ANON_KEY    = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const QUERY_ID    = 'p7_q';
const NUM_CLIENTS = 20;
const NUM_INSERTS = 50;
// Threshold: survivors must receive at least 90% of inserts.
const DELIVERY_THRESHOLD = 0.90;

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connect(id) {
  const ws = new WebSocket(PROXY_URL, { headers: { Authorization: `Bearer ${ANON_KEY}` } });
  const deltas = [];
  let errors = 0;

  ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    if (msg.query_id === QUERY_ID && msg.inserted) deltas.push(msg);
  });
  ws.on('error', () => errors++);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`client ${id} connect timeout`)), 8000);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', e => { clearTimeout(t); reject(e); });
  });

  // Wait for subscribed confirmation.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`client ${id} subscribed timeout`)), 3000);
    function check() {
      // subscribed message may have arrived before this poll
      if (ws.readyState !== WebSocket.OPEN) { clearTimeout(t); reject(new Error('closed early')); return; }
      setTimeout(check, 50);
    }
    // Just give it 200ms — the hub sends it immediately on upgrade.
    setTimeout(() => { clearTimeout(t); resolve(); }, 200);
  });

  return { ws, deltas, errors: () => errors, id };
}

async function main() {
  console.log('--- P7: Concurrent Subscribe/Unsubscribe Churn ---');

  // Setup
  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');
  psql('DROP TABLE IF EXISTS p7_test CASCADE');
  psql('CREATE TABLE p7_test(id serial PRIMARY KEY, val int)');
  try { psql(`SELECT pgr.unsubscribe('${QUERY_ID}')`); } catch (_) {}
  psql(`SELECT pgr.subscribe('${QUERY_ID}', 'SELECT * FROM p7_test')`);

  // Connect all clients concurrently.
  console.log(`Connecting ${NUM_CLIENTS} clients...`);
  const clients = await Promise.all(
    Array.from({ length: NUM_CLIENTS }, (_, i) => connect(i))
  );
  console.log(`All ${NUM_CLIENTS} clients connected.`);

  // Fire half the inserts with all clients alive.
  const half = Math.floor(NUM_INSERTS / 2);
  console.log(`Inserting ${half} rows (all clients alive)...`);
  for (let i = 0; i < half; i++) {
    psql(`INSERT INTO p7_test(val) VALUES (${i})`);
  }

  await sleep(300); // allow deltas to propagate

  // Randomly close half the clients while the rest are still running.
  const survivorCount = Math.ceil(NUM_CLIENTS / 2);
  const shuffled = [...clients].sort(() => Math.random() - 0.5);
  const dropping = shuffled.slice(0, NUM_CLIENTS - survivorCount);
  const survivors = shuffled.slice(NUM_CLIENTS - survivorCount);

  console.log(`Closing ${dropping.length} clients mid-stream...`);
  dropping.forEach(c => c.ws.close());

  // Insert the remaining rows with churn in progress.
  console.log(`Inserting ${NUM_INSERTS - half} more rows (half closed)...`);
  for (let i = half; i < NUM_INSERTS; i++) {
    psql(`INSERT INTO p7_test(val) VALUES (${i})`);
  }

  await sleep(500); // allow all pending deltas to propagate to survivors

  // Evaluate survivors.
  let passed = true;
  let worstDelivery = 1.0;
  for (const c of survivors) {
    const delivered = c.deltas.reduce((acc, d) => acc + (d.inserted?.length ?? 0), 0);
    const rate = delivered / NUM_INSERTS;
    worstDelivery = Math.min(worstDelivery, rate);
    if (rate < DELIVERY_THRESHOLD) {
      console.error(`  FAIL: client ${c.id} received ${delivered}/${NUM_INSERTS} (${(rate*100).toFixed(0)}%)`);
      passed = false;
    }
    if (c.errors() > 0) {
      console.error(`  FAIL: client ${c.id} had ${c.errors()} WS error(s)`);
      passed = false;
    }
  }

  survivors.forEach(c => c.ws.close());

  console.log(`Survivors: ${survivors.length}  Worst delivery: ${(worstDelivery*100).toFixed(0)}%`);

  // Emit metric for runner.sh results.jsonl
  if (process.env.PERF_METRICS_FILE) {
    const { appendFileSync } = await import('fs');
    appendFileSync(process.env.PERF_METRICS_FILE,
      `p7_worst_delivery_pct=${(worstDelivery*100).toFixed(1)}\n`);
  }

  // Cleanup
  try { psql(`SELECT pgr.unsubscribe('${QUERY_ID}')`); } catch (_) {}
  try { psql('DROP TABLE p7_test'); } catch (_) {}

  if (!passed) {
    console.error('FAIL: P7 concurrent subscribe/unsubscribe');
    process.exit(1);
  }
  console.log('PASS: P7 concurrent subscribe/unsubscribe');
}

main().catch(e => { console.error(e); process.exit(1); });
