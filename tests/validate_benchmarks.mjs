/**
 * Benchmark Validation: pg_reactive Habr Article Claims
 *
 * Runs reproducible benchmarks to validate numeric claims:
 *   B1: Write-to-client latency (100 inserts, idle load)
 *   B2: Fan-out — 200 concurrent WebSocket clients (0 misses)
 *   B3: Fan-out — 500 concurrent WebSocket clients (miss rate < 5%)
 *
 * Prerequisites:
 *   - Docker compose running (pg_reactive dev stack on port 8080)
 *   - ws package installed in tests/ (auto-installed if missing)
 *
 * Usage:
 *   node tests/validate_benchmarks.mjs
 */
import { psql, waitForMessage } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { spawn } from 'child_process';
import os from 'os';

const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const PROXY_WS = 'ws://127.0.0.1:8080';
const PROXY_HTTP = 'http://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmtMs(v) {
  if (v == null || isNaN(v)) return 'N/A';
  return `${v.toFixed(1)}ms`;
}

function connectWS(queryId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${PROXY_WS}/ws/${queryId}?apikey=${encodeURIComponent(ANON_KEY)}`
    );
    const state = { ws, messages: [], deltas: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      state.messages.push(msg);
      if (msg.inserted || msg.deleted) {
        state.deltas.push({ ts: performance.now(), msg });
      }
    });
    ws.on('open', () => resolve(state));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function spawnPsqlPipe() {
  return spawn('docker', [
    'compose', 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', 'pg_reactive_test',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// B1: Write-to-Client Latency
// ---------------------------------------------------------------------------

async function benchLatency() {
  const QUERY_ID = 'vb_lat';
  const INSERT_COUNT = 100;
  const INSERT_DELAY_MS = 100;

  // Setup
  psql('DROP TABLE IF EXISTS vb_latency CASCADE');
  psql('CREATE TABLE vb_latency (id serial PRIMARY KEY, seq int)');
  psql(`SELECT pgr.subscribe('${QUERY_ID}', 'SELECT id, seq FROM vb_latency ORDER BY id DESC LIMIT 50')`);

  const client = await connectWS(QUERY_ID);

  // Wait for subscribed message
  await waitForMessage(client.messages, m => m.type === 'subscribed', 5000);

  // Clear messages after subscribed
  client.messages.length = 0;
  client.deltas.length = 0;

  const sendTimes = new Map(); // seq -> performance.now()
  const latencies = [];

  // Set up message handler to match seq values
  const originalHandler = client.ws.listeners('message').slice(-1)[0];
  client.ws.removeListener('message', originalHandler);

  client.ws.on('message', (data) => {
    const recvTime = performance.now();
    const msg = JSON.parse(data.toString());
    client.messages.push(msg);

    if (msg.inserted) {
      for (const row of msg.inserted) {
        const seq = row.seq;
        if (seq != null && sendTimes.has(seq)) {
          latencies.push(recvTime - sendTimes.get(seq));
          sendTimes.delete(seq);
        }
      }
    }
  });

  // Open a persistent psql pipe for fast sequential inserts
  const pipe = spawnPsqlPipe();
  pipe.stdout.resume();
  pipe.stderr.resume();

  for (let i = 1; i <= INSERT_COUNT; i++) {
    sendTimes.set(i, performance.now());
    pipe.stdin.write(`INSERT INTO vb_latency (seq) VALUES (${i});\n`);
    if (i < INSERT_COUNT) await sleep(INSERT_DELAY_MS);
  }

  // Close psql pipe gracefully
  pipe.stdin.write('\\q\n');
  pipe.stdin.end();
  await new Promise(resolve => pipe.on('close', resolve));

  // Drain period: wait for remaining WS messages
  await sleep(3000);

  client.ws.close();

  // Cleanup
  try { psql(`SELECT pgr.unsubscribe('${QUERY_ID}')`); } catch {}
  try { psql('DROP TABLE IF EXISTS vb_latency CASCADE'); } catch {}

  const p50 = latencies.length ? percentile(latencies, 50) : NaN;
  const p95 = latencies.length ? percentile(latencies, 95) : NaN;
  const p99 = latencies.length ? percentile(latencies, 99) : NaN;
  const pass = !isNaN(p50) && p50 < 50;

  return {
    name: 'B1',
    title: 'Write-to-Client Latency (100 inserts, idle load)',
    matched: latencies.length,
    total: INSERT_COUNT,
    p50, p95, p99,
    pass,
    summary: [
      `  P50: ${fmtMs(p50)}  P95: ${fmtMs(p95)}  P99: ${fmtMs(p99)}`,
      `  Matched: ${latencies.length}/${INSERT_COUNT}`,
      `  ${pass ? 'PASS' : 'FAIL'}: P50 ${pass ? '<' : '>='} 50ms (article claims ~3ms)`,
    ],
  };
}

// ---------------------------------------------------------------------------
// B2 / B3: Fan-Out
// ---------------------------------------------------------------------------

async function benchFanout(clientCount, queryId, tableName, passThreshold) {
  const BATCH_SIZE = 50;
  const BATCH_DELAY_MS = 200;
  const INSERT_COUNT = 10;
  const INSERT_DELAY_MS = 500;
  const DRAIN_MS = 3000;

  // Setup
  psql(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
  psql(`CREATE TABLE ${tableName} (id serial PRIMARY KEY, val int)`);
  psql(`SELECT pgr.subscribe('${queryId}', 'SELECT id, val FROM ${tableName} ORDER BY id DESC LIMIT 50')`);

  // Connect clients in batches
  const clients = [];
  let connectFailed = 0;

  for (let i = 0; i < clientCount; i += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, clientCount - i);
    const promises = Array.from({ length: batchSize }, () =>
      connectWS(queryId).catch(() => null)
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) clients.push(r);
      else connectFailed++;
    }
    if (i + BATCH_SIZE < clientCount) await sleep(BATCH_DELAY_MS);
  }

  // Wait for all clients to receive subscribed message
  const subscribedDeadline = Date.now() + 15000;
  while (Date.now() < subscribedDeadline) {
    const allSubscribed = clients.every(c =>
      c.messages.some(m => m.type === 'subscribed')
    );
    if (allSubscribed) break;
    await sleep(100);
  }

  const subscribedCount = clients.filter(c =>
    c.messages.some(m => m.type === 'subscribed')
  ).length;

  // Clear deltas before measurement
  for (const c of clients) {
    c.deltas.length = 0;
  }

  // Insert rows
  for (let i = 1; i <= INSERT_COUNT; i++) {
    psql(`INSERT INTO ${tableName} (val) VALUES (${i})`);
    if (i < INSERT_COUNT) await sleep(INSERT_DELAY_MS);
  }

  // Wait for delivery
  await sleep(DRAIN_MS);

  // Count deltas per client
  const expectedTotal = clients.length * INSERT_COUNT;
  let totalReceived = 0;
  for (const c of clients) {
    totalReceived += c.deltas.length;
  }
  const totalMissed = expectedTotal - totalReceived;
  const missRate = expectedTotal > 0 ? (totalMissed / expectedTotal) * 100 : 0;

  // Compute first/last delivery latency for the first insert (informational)
  // Not meaningful across inserts since we don't track sendTime per insert here

  // Close all
  for (const c of clients) {
    try { c.ws.close(); } catch {}
  }

  // Cleanup
  try { psql(`SELECT pgr.unsubscribe('${queryId}')`); } catch {}
  try { psql(`DROP TABLE IF EXISTS ${tableName} CASCADE`); } catch {}

  const pass = missRate <= passThreshold;

  return {
    connected: clients.length,
    requested: clientCount,
    connectFailed,
    subscribedCount,
    expectedTotal,
    totalReceived,
    totalMissed,
    missRate,
    pass,
  };
}

async function benchFanout200() {
  const r = await benchFanout(200, 'vb_fan200', 'vb_fanout200', 0);

  return {
    name: 'B2',
    title: 'Fan-Out -- 200 Concurrent Clients',
    pass: r.pass,
    summary: [
      `  Connected: ${r.connected}/${r.requested}${r.connectFailed ? ` (${r.connectFailed} failed)` : ''}`,
      `  Subscribed: ${r.subscribedCount}/${r.connected}`,
      `  Deltas expected: ${r.expectedTotal}, received: ${r.totalReceived}, missed: ${r.totalMissed}`,
      `  ${r.pass ? 'PASS' : 'FAIL'}: ${r.totalMissed === 0 ? '0 misses' : `${r.totalMissed} misses`}`,
    ],
  };
}

async function benchFanout500() {
  const r = await benchFanout(500, 'vb_fan500', 'vb_fanout500', 5);

  return {
    name: 'B3',
    title: 'Fan-Out -- 500 Concurrent Clients',
    pass: r.pass,
    summary: [
      `  Connected: ${r.connected}/${r.requested}${r.connectFailed ? ` (${r.connectFailed} failed)` : ''}`,
      `  Subscribed: ${r.subscribedCount}/${r.connected}`,
      `  Deltas expected: ${r.expectedTotal}, received: ${r.totalReceived}, missed: ${r.totalMissed}`,
      `  Miss rate: ${r.missRate.toFixed(1)}%`,
      `  ${r.pass ? 'PASS' : 'FAIL'}: miss rate ${r.pass ? '<=' : '>'} 5%`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Methodology
// ---------------------------------------------------------------------------

function getMethodology() {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'unknown';
  const cpuCount = cpus.length;
  const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const hostname = os.hostname();
  const now = new Date().toISOString().split('T')[0];

  let pgVersion = 'unknown';
  try { pgVersion = psql('SHOW server_version').trim(); } catch {}

  let extVersion = 'unknown';
  try {
    extVersion = psql(
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_reactive'"
    ).trim();
  } catch {}

  return [
    '',
    '=== Methodology ===',
    `Hardware: ${cpuModel} (${cpuCount} cores), ${totalMem} GB RAM`,
    `Hostname: ${hostname}`,
    `PostgreSQL: ${pgVersion} with pg_reactive ${extVersion}`,
    'Proxy: pgstack-proxy-go (chi)',
    'Network: localhost loopback (Docker Desktop on Windows / WSL2)',
    `Date: ${now}`,
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== pg_reactive Benchmark Validation ===');
  console.log('');

  // Ensure extension is loaded
  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');

  const results = [];
  let failures = 0;

  try {
    // B1: Latency
    console.log('Running B1: Write-to-Client Latency...');
    const b1 = await benchLatency();
    results.push(b1);
    if (!b1.pass) failures++;
    console.log('');
    console.log(`B1: ${b1.title}`);
    for (const line of b1.summary) console.log(line);
    console.log('');

    // B2: 200 clients
    console.log('Running B2: Fan-Out -- 200 Concurrent Clients...');
    const b2 = await benchFanout200();
    results.push(b2);
    if (!b2.pass) failures++;
    console.log('');
    console.log(`B2: ${b2.title}`);
    for (const line of b2.summary) console.log(line);
    console.log('');

    // B3: 500 clients
    console.log('Running B3: Fan-Out -- 500 Concurrent Clients...');
    const b3 = await benchFanout500();
    results.push(b3);
    if (!b3.pass) failures++;
    console.log('');
    console.log(`B3: ${b3.title}`);
    for (const line of b3.summary) console.log(line);

  } finally {
    // Final cleanup (defensive, in case individual cleanups failed)
    const cleanupQueries = [
      "SELECT pgr.unsubscribe('vb_lat')",
      "SELECT pgr.unsubscribe('vb_fan200')",
      "SELECT pgr.unsubscribe('vb_fan500')",
      'DROP TABLE IF EXISTS vb_latency CASCADE',
      'DROP TABLE IF EXISTS vb_fanout200 CASCADE',
      'DROP TABLE IF EXISTS vb_fanout500 CASCADE',
    ];
    for (const q of cleanupQueries) {
      try { psql(q); } catch {}
    }
  }

  // Methodology
  const methodology = getMethodology();
  for (const line of methodology) console.log(line);

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log('');
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);

  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Benchmark validation error:', e);

  // Emergency cleanup
  const cleanupQueries = [
    "SELECT pgr.unsubscribe('vb_lat')",
    "SELECT pgr.unsubscribe('vb_fan200')",
    "SELECT pgr.unsubscribe('vb_fan500')",
    'DROP TABLE IF EXISTS vb_latency CASCADE',
    'DROP TABLE IF EXISTS vb_fanout200 CASCADE',
    'DROP TABLE IF EXISTS vb_fanout500 CASCADE',
  ];
  for (const q of cleanupQueries) {
    try { psql(q); } catch {}
  }

  process.exit(1);
});
