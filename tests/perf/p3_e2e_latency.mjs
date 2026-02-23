/**
 * P3: End-to-End Delta Latency
 *
 * Measures full pipeline latency:
 *   SQL INSERT -> PG trigger -> EXCEPT delta -> NOTIFY -> Rust proxy -> WebSocket client
 *
 * Prerequisites: docker compose up -d (DB + proxy running)
 */
import WebSocket from 'ws';
import { execFileSync, spawn } from 'child_process';
import { performance } from 'perf_hooks';

const WS_URL = 'ws://127.0.0.1:8080/ws/p3_q';
const QUERY_ID = 'p3_q';

const LEVELS = [
  { name: 'idle',     intervalMs: 200, count: 50,   durationLabel: '50 writes' },
  { name: 'moderate', intervalMs: 100, count: 300,  durationLabel: '300 writes' },
  { name: 'high',     intervalMs: 10,  count: 1500, durationLabel: '1500 writes' },
];

const THRESHOLDS = {
  idle:     { pct: 'p50', limitMs: 200 },
  moderate: { pct: 'p95', limitMs: 800 },
};

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

function spawnPsqlPipe() {
  return spawn('docker', [
    'compose', 'exec', '-T', 'db',
    'psql', '-U', 'postgres', '-d', 'pg_reactive_test',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function connectWs() {
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  return ws;
}

async function runLevel(level, ws) {
  const { name, intervalMs, count } = level;
  const sendTimes = new Map();   // seq -> sendTime
  const latencies = [];
  let overflows = 0;

  const onMessage = (data) => {
    const recvTime = performance.now();
    const msg = JSON.parse(data.toString());

    if (msg.type === 'subscribed' || msg.type === 'overflow') {
      if (msg.type === 'overflow') overflows++;
      return;
    }

    const rows = msg.inserted || [];
    for (const row of rows) {
      const seq = row.seq;
      if (seq != null && sendTimes.has(seq)) {
        latencies.push(recvTime - sendTimes.get(seq));
        sendTimes.delete(seq);
      }
    }
  };

  ws.on('message', onMessage);

  const pipe = spawnPsqlPipe();

  // Discard pipe stdout/stderr to prevent backpressure
  pipe.stdout.resume();
  pipe.stderr.resume();

  for (let i = 1; i <= count; i++) {
    sendTimes.set(i, performance.now());
    pipe.stdin.write(`INSERT INTO p3_data (seq) VALUES (${i});\n`);
    if (i < count) await sleep(intervalMs);
  }

  // Close the psql pipe gracefully
  pipe.stdin.write('\\q\n');
  pipe.stdin.end();
  await new Promise(resolve => pipe.on('close', resolve));

  // Drain period: wait for remaining WS messages
  await sleep(3000);

  ws.removeListener('message', onMessage);

  const sorted = latencies.slice().sort((a, b) => a - b);
  const matched = latencies.length;

  const stats = {
    name,
    count,
    matched,
    overflows,
    p50: sorted.length ? percentile(sorted, 50) : NaN,
    p95: sorted.length ? percentile(sorted, 95) : NaN,
    p99: sorted.length ? percentile(sorted, 99) : NaN,
  };

  return stats;
}

async function main() {
  console.log('=== P3: End-to-End Delta Latency ===');

  // Setup
  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');
  psql('DROP TABLE IF EXISTS p3_data CASCADE');
  psql('CREATE TABLE p3_data (id serial PRIMARY KEY, seq int)');
  psql(`SELECT pgr.subscribe('${QUERY_ID}', 'SELECT id, seq FROM p3_data ORDER BY id DESC LIMIT 50')`);

  const ws = await connectWs();

  // Wait for subscribed message
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribed') {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
  });

  const results = [];

  try {
    for (const level of LEVELS) {
      // Reset table between levels to keep snapshot small
      psql('TRUNCATE p3_data');
      await sleep(1000);

      const stats = await runLevel(level, ws);
      results.push(stats);
    }

    // Print results
    console.log('');
    for (const r of results) {
      const pad = (s, n) => s.padEnd(n);
      const fmtMs = (v) => isNaN(v) ? '   N/A' : `${v.toFixed(1).padStart(6)}ms`;
      console.log(
        `${pad(r.name, 9)}(${r.count.toString().padStart(4)} writes):  ` +
        `p50=${fmtMs(r.p50)}  p95=${fmtMs(r.p95)}  p99=${fmtMs(r.p99)}  ` +
        `matched=${r.matched}/${r.count}` +
        (r.overflows ? `  overflows=${r.overflows}` : '')
      );
    }

    // Check thresholds
    let pass = true;
    console.log('--- Thresholds ---');
    for (const r of results) {
      const threshold = THRESHOLDS[r.name];
      if (!threshold) continue;

      const { pct, limitMs } = threshold;
      const value = r[pct];
      const ok = !isNaN(value) && value < limitMs;
      if (!ok) pass = false;

      console.log(
        `${r.name} ${pct}: ${isNaN(value) ? 'N/A' : value.toFixed(1) + 'ms'} ` +
        `[${ok ? 'PASS' : 'FAIL'}] (< ${limitMs}ms)`
      );
    }

    console.log(`=== P3: ${pass ? 'PASS' : 'FAIL'} ===`);
    return pass ? 0 : 1;
  } finally {
    ws.close();
    try { psql(`SELECT pgr.unsubscribe('${QUERY_ID}')`); } catch { /* ignore */ }
    try { psql('DROP TABLE IF EXISTS p3_data CASCADE'); } catch { /* ignore */ }
  }
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error('P3 error:', e);
    process.exit(1);
  });
