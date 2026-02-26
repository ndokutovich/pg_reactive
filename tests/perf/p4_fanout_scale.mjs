/**
 * P4: WebSocket Fan-Out Scaling
 *
 * Measures how many WebSocket clients can receive simultaneous deltas
 * and how latency degrades as client count increases.
 *
 * Runs on HOST (Node.js), connects to WS proxy at 127.0.0.1:8080.
 *
 * Usage:
 *   node tests/perf/p4_fanout_scale.mjs
 */
import WebSocket from 'ws';
import { execFileSync } from 'child_process';

const WS_URL = 'ws://127.0.0.1:8080/ws/p4_q';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const LEVELS = [10, 50, 100, 200, 500];
const INSERTS_PER_LEVEL = 20;
const INSERT_INTERVAL_MS = 200;
const CONNECT_BATCH_SIZE = 50;
const DELTA_TIMEOUT_MS = 10_000;

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

function percentile(sorted, pct) {
  const idx = Math.floor(sorted.length * pct / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function connectOne() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${ANON_KEY}` } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connect timeout'));
    }, 10_000);

    ws.once('open', () => {
      clearTimeout(timer);
      const state = { ws, subscribed: false, deltas: [] };

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribed') {
          state.subscribed = true;
          return;
        }
        if (msg.query_id === 'p4_q' && msg.inserted) {
          state.deltas.push({ ts: Date.now(), msg });
        }
      });

      resolve(state);
    });

    ws.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function connectBatch(count) {
  const clients = [];
  for (let i = 0; i < count; i += CONNECT_BATCH_SIZE) {
    const batchSize = Math.min(CONNECT_BATCH_SIZE, count - i);
    const promises = Array.from({ length: batchSize }, () => connectOne());
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled') clients.push(r.value);
    }
    if (i + CONNECT_BATCH_SIZE < count) await sleep(200);
  }
  return clients;
}

async function waitSubscribed(clients, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (clients.every(c => c.subscribed)) return true;
    await sleep(100);
  }
  return clients.every(c => c.subscribed);
}

function closeAll(clients) {
  for (const c of clients) {
    try { c.ws.close(); } catch {}
  }
}

async function runLevel(n) {
  const clients = await connectBatch(n);
  if (clients.length < n) {
    console.error(`  Warning: only ${clients.length}/${n} clients connected`);
  }

  const allSubscribed = await waitSubscribed(clients);
  if (!allSubscribed) {
    const subCount = clients.filter(c => c.subscribed).length;
    console.error(`  Warning: only ${subCount}/${clients.length} received subscribed`);
  }

  await sleep(1000);

  const sendTimes = [];

  for (let i = 0; i < INSERTS_PER_LEVEL; i++) {
    const sendTime = Date.now();
    psql(`INSERT INTO p4_data(val) VALUES (${1000 + i})`);
    sendTimes.push(sendTime);
    await sleep(INSERT_INTERVAL_MS);
  }

  // Wait for trailing deltas
  await sleep(DELTA_TIMEOUT_MS);

  // Analyze: for each insert we check all client deltas collected after sendTime
  const firstLatencies = [];
  const lastLatencies = [];
  let totalMisses = 0;

  for (let i = 0; i < INSERTS_PER_LEVEL; i++) {
    const tSend = sendTimes[i];
    // Window: from tSend to tSend + DELTA_TIMEOUT_MS
    const tDeadline = tSend + DELTA_TIMEOUT_MS;
    let earliest = Infinity;
    let latest = -Infinity;
    let misses = 0;

    for (const c of clients) {
      // Find the first delta this client received after tSend for this insert window
      // Since deltas array was cleared before each insert and we wait INSERT_INTERVAL_MS,
      // we use sendTimes to correlate: delta received between tSend and next tSend (or deadline)
      const tNext = i < INSERTS_PER_LEVEL - 1 ? sendTimes[i + 1] : tSend + DELTA_TIMEOUT_MS;
      const delta = c.deltas.find(d => d.ts >= tSend && d.ts < tNext);

      if (!delta) {
        misses++;
      } else {
        const lat = delta.ts - tSend;
        if (lat < earliest) earliest = lat;
        if (lat > latest) latest = lat;
      }
    }

    totalMisses += misses;
    if (earliest < Infinity) firstLatencies.push(earliest);
    if (latest > -Infinity) lastLatencies.push(latest);
  }

  closeAll(clients);

  firstLatencies.sort((a, b) => a - b);
  lastLatencies.sort((a, b) => a - b);

  return {
    n: clients.length,
    first_p50: firstLatencies.length ? percentile(firstLatencies, 50) : NaN,
    first_p95: firstLatencies.length ? percentile(firstLatencies, 95) : NaN,
    last_p50: lastLatencies.length ? percentile(lastLatencies, 50) : NaN,
    last_p95: lastLatencies.length ? percentile(lastLatencies, 95) : NaN,
    misses: totalMisses,
  };
}

function fmt(v) {
  if (Number.isNaN(v)) return '   N/A';
  return v.toFixed(1).padStart(6) + 'ms';
}

async function main() {
  console.log('=== P4: WebSocket Fan-Out Scaling ===');

  // Setup
  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');
  psql('DROP TABLE IF EXISTS p4_data CASCADE');
  psql('CREATE TABLE p4_data (id serial PRIMARY KEY, val int)');
  psql("SELECT pgr.subscribe('p4_q', 'SELECT id, val FROM p4_data')");

  const results = [];

  for (const level of LEVELS) {
    // Clean inserted rows between levels so deltas stay small
    psql('DELETE FROM p4_data');
    const r = await runLevel(level);
    results.push(r);
    const label = String(r.n).padStart(3);
    console.log(
      `${label} clients: first_p50=${fmt(r.first_p50)}  last_p50=${fmt(r.last_p50)}  last_p95=${fmt(r.last_p95)}  misses=${r.misses}`
    );
    await sleep(2000);
  }

  // Thresholds
  console.log('--- Thresholds ---');
  const r100 = results.find(r => r.n >= 100 && r.n <= 100);
  let pass = true;

  if (r100) {
    const lp95Pass = r100.last_p95 < 1500;
    console.log(
      `100-client last_p95: ${r100.last_p95.toFixed(1)}ms [${lp95Pass ? 'PASS' : 'FAIL'}] (< 1500ms)`
    );
    if (!lp95Pass) pass = false;

    const missPass = r100.misses === 0;
    console.log(
      `100-client misses: ${r100.misses} [${missPass ? 'PASS' : 'FAIL'}] (must be 0)`
    );
    if (!missPass) pass = false;
  } else {
    console.log('100-client level not reached, cannot check thresholds');
    pass = false;
  }

  // Cleanup
  try {
    psql("SELECT pgr.unsubscribe('p4_q')");
    psql('DROP TABLE IF EXISTS p4_data CASCADE');
  } catch {}

  console.log(`=== P4: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => {
  console.error('P4 error:', e);
  try {
    psql("SELECT pgr.unsubscribe('p4_q')");
    psql('DROP TABLE IF EXISTS p4_data CASCADE');
  } catch {}
  process.exit(1);
});
