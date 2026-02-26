/**
 * P5: Sustained Load (Soak Test)
 *
 * 3 minutes of continuous writes at 50/sec looking for latency drift,
 * delivery failures, or degradation across 5 WebSocket clients.
 *
 * Prerequisites: docker compose up -d (PG + proxy running)
 * Usage: node tests/perf/p5_soak.mjs
 */
import WebSocket from 'ws';
import { execFileSync, execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import { performance } from 'perf_hooks';

const execFileAsync = promisify(execFileCb);

const WS_URL = 'ws://127.0.0.1:8080/ws/p5_q';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const NUM_CLIENTS = 5;
const WRITES_PER_SEC = 50;
const DURATION_SEC = 180;
const CHECKPOINT_SEC = 10;
const DRAIN_SEC = 5;
const TOTAL_WRITES = WRITES_PER_SEC * DURATION_SEC;

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

function pad(n, w) { return String(n).padStart(w, ' '); }
function fms(v) { return v.toFixed(1) + 'ms'; }

async function connectClient(id) {
  const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${ANON_KEY}` } });
  const state = { ws, id, msgCount: 0 };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Client ${id}: connect timeout`)), 10000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  await new Promise(r => setTimeout(r, 500));
  return state;
}

async function main() {
  console.log('=== P5: Sustained Load (Soak Test) ===');
  console.log(`Duration: ${DURATION_SEC}s | Writes: ${TOTAL_WRITES} | Clients: ${NUM_CLIENTS}`);

  // --- Setup ---
  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');
  psql('DROP TABLE IF EXISTS p5_data CASCADE');
  psql('CREATE TABLE p5_data (id serial PRIMARY KEY, seq int, payload text)');
  psql("INSERT INTO p5_data (seq, payload) SELECT g, repeat('x', 50) FROM generate_series(1, 1000) g");
  psql("SELECT pgr.subscribe('p5_q', 'SELECT id, seq FROM p5_data ORDER BY id DESC LIMIT 200')");

  // --- Connect WS clients ---
  const clients = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    clients.push(await connectClient(i));
  }

  // --- Tracking state ---
  let globalSeq = 10000;
  const sendTimes = new Map();          // seq -> performance.now()
  const windowLatencies = [];           // latencies for current checkpoint window
  const checkpoints = [];               // { sec, writes, delivered, p50, p95, p99 }
  let totalDelivered = 0;
  let totalWritten = 0;
  let windowWritten = 0;

  // Wire up WS message handlers
  for (const c of clients) {
    c.ws.on('message', (data) => {
      const now = performance.now();
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.inserted || !Array.isArray(msg.inserted)) return;
        c.msgCount++;
        for (const row of msg.inserted) {
          const seq = row.seq;
          if (seq != null && sendTimes.has(seq)) {
            const latency = now - sendTimes.get(seq);
            windowLatencies.push(latency);
            sendTimes.delete(seq);
            totalDelivered++;
          }
        }
      } catch { /* ignore parse errors */ }
    });
  }

  // --- Spawn persistent psql pipe ---
  const psqlProc = spawn(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  // Drain stdout/stderr to prevent backpressure
  psqlProc.stdout.on('data', () => {});
  psqlProc.stderr.on('data', () => {});

  // --- Write loop ---
  const startTime = performance.now();
  let nextCheckpoint = CHECKPOINT_SEC;
  let writesSinceLastCheckpoint = 0;

  const writeInterval = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    if (elapsed >= DURATION_SEC) return;

    globalSeq++;
    const seq = globalSeq;
    sendTimes.set(seq, performance.now());
    psqlProc.stdin.write(`INSERT INTO p5_data (seq, payload) VALUES (${seq}, repeat('x', 50));\n`);
    totalWritten++;
    windowWritten++;
    writesSinceLastCheckpoint++;
  }, 1000 / WRITES_PER_SEC);

  // --- Checkpoint loop ---
  const checkpointInterval = setInterval(() => {
    const elapsedSec = Math.round((performance.now() - startTime) / 1000);
    if (elapsedSec < nextCheckpoint) return;

    const sorted = windowLatencies.slice().sort((a, b) => a - b);
    const delivered = sorted.length;
    const p50 = sorted.length > 0 ? percentile(sorted, 50) : 0;
    const p95 = sorted.length > 0 ? percentile(sorted, 95) : 0;
    const p99 = sorted.length > 0 ? percentile(sorted, 99) : 0;

    checkpoints.push({
      sec: nextCheckpoint,
      writes: totalWritten,
      delivered: totalDelivered,
      windowDelivered: delivered,
      windowWrites: writesSinceLastCheckpoint,
      p50, p95, p99
    });

    console.log(
      `[${pad(nextCheckpoint, 3)}s] ` +
      `writes=${pad(totalWritten, 5)}  ` +
      `delivered=${pad(totalDelivered, 5)}  ` +
      `p50=${pad(fms(p50), 8)}  ` +
      `p95=${pad(fms(p95), 8)}  ` +
      `p99=${pad(fms(p99), 8)}`
    );

    // Reset window
    windowLatencies.length = 0;
    writesSinceLastCheckpoint = 0;
    nextCheckpoint += CHECKPOINT_SEC;

    // Prune stale sendTimes older than 30s to bound memory
    const cutoff = performance.now() - 30000;
    for (const [k, v] of sendTimes) {
      if (v < cutoff) sendTimes.delete(k);
    }
  }, 1000);

  // --- Wait for duration + drain ---
  await new Promise(r => setTimeout(r, DURATION_SEC * 1000));
  clearInterval(writeInterval);

  // Flush final checkpoint window if not yet emitted
  if (windowLatencies.length > 0 || writesSinceLastCheckpoint > 0) {
    const sorted = windowLatencies.slice().sort((a, b) => a - b);
    const delivered = sorted.length;
    const p50 = sorted.length > 0 ? percentile(sorted, 50) : 0;
    const p95 = sorted.length > 0 ? percentile(sorted, 95) : 0;
    const p99 = sorted.length > 0 ? percentile(sorted, 99) : 0;
    checkpoints.push({
      sec: DURATION_SEC,
      writes: totalWritten,
      delivered: totalDelivered,
      windowDelivered: delivered,
      windowWrites: writesSinceLastCheckpoint,
      p50, p95, p99
    });
    console.log(
      `[${pad(DURATION_SEC, 3)}s] ` +
      `writes=${pad(totalWritten, 5)}  ` +
      `delivered=${pad(totalDelivered, 5)}  ` +
      `p50=${pad(fms(p50), 8)}  ` +
      `p95=${pad(fms(p95), 8)}  ` +
      `p99=${pad(fms(p99), 8)}`
    );
  }

  // Drain period
  await new Promise(r => setTimeout(r, DRAIN_SEC * 1000));
  clearInterval(checkpointInterval);

  // --- Compute final results ---
  const firstCp = checkpoints[0];
  const lastCp = checkpoints[checkpoints.length - 1];
  const firstP50 = firstCp ? firstCp.p50 : 0;
  const lastP50 = lastCp ? lastCp.p50 : 0;
  const drift = firstP50 > 0 ? lastP50 / firstP50 : 0;
  const deliveryRate = totalWritten > 0 ? (totalDelivered / totalWritten) * 100 : 0;
  const maxP99 = Math.max(...checkpoints.map(c => c.p99));

  const clientCounts = clients.map(c => c.msgCount);
  const minClient = Math.min(...clientCounts);
  const maxClient = Math.max(...clientCounts);

  console.log('\n--- Summary ---');
  console.log(`First window p50:  ${fms(firstP50)}`);
  console.log(`Last window p50:   ${fms(lastP50)}`);
  console.log(`Drift ratio:       ${drift.toFixed(2)}x`);
  console.log(`Delivery rate:     ${deliveryRate.toFixed(1)}% (${totalDelivered}/${totalWritten})`);
  console.log(`Client balance:    min=${minClient} max=${maxClient}`);
  console.log(`Max p99:           ${fms(maxP99)}`);

  // --- Thresholds ---
  const driftPass = drift < 5.0;  // Table grows ~6x during test, some drift expected
  const deliveryPass = deliveryRate >= 95;
  const p99Pass = maxP99 < 5000;

  console.log('\n--- Thresholds ---');
  const driftWarn = drift >= 2.0;
  const driftLabel = !driftPass ? 'FAIL' : driftWarn ? 'WARN' : 'PASS';
  console.log(`Drift: ${drift.toFixed(2)}x [${driftLabel}] (< 5.0x, warn > 2.0x)`);
  console.log(`Delivery: ${deliveryRate.toFixed(1)}% [${deliveryPass ? 'PASS' : 'FAIL'}] (>= 95%)`);
  console.log(`Max p99: ${fms(maxP99)} [${p99Pass ? 'PASS' : 'FAIL'}] (< 5000ms)`);

  const allPass = driftPass && deliveryPass && p99Pass;
  console.log(`=== P5: ${allPass ? 'PASS' : 'FAIL'} ===`);

  // Save pg_reactive stats for comparison
  const reactiveP50 = lastP50;
  const reactiveP95 = lastCp ? lastCp.p95 : 0;
  const reactiveDelivery = deliveryRate;

  // --- Polling Soak (60s comparison) ---
  console.log('\n=== Polling Soak (60s comparison) ===');

  const POLL_DURATION_SEC = 60;
  const POLL_INTERVAL_MS = 200;
  const POLL_WRITES_PER_SEC = 50;
  const POLL_TOTAL_WRITES = POLL_WRITES_PER_SEC * POLL_DURATION_SEC;
  const POLL_CHECKPOINT_SEC = 10;

  // Reset table
  psql('TRUNCATE p5_data');
  psql("INSERT INTO p5_data (seq, payload) SELECT g, repeat('x', 50) FROM generate_series(1, 1000) g");

  console.log(`Duration: ${POLL_DURATION_SEC}s | Writes: ${POLL_TOTAL_WRITES} | Poll interval: ${POLL_INTERVAL_MS}ms`);

  // Polling state
  let pollGlobalSeq = 20000;
  const pollSendTimes = new Map();        // seq -> performance.now()
  const pollWindowLatencies = [];
  const pollCheckpoints = [];
  let pollTotalDelivered = 0;
  let pollTotalWritten = 0;
  let pollWindowWritten = 0;
  let pollWritesSinceCheckpoint = 0;
  let pollLastMaxSeq = null;

  // Spawn write pipe for polling phase
  const pollPsqlProc = spawn(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  pollPsqlProc.stdout.on('data', () => {});
  pollPsqlProc.stderr.on('data', () => {});

  async function pollMaxSeq() {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c',
         'SELECT MAX(seq) FROM p5_data']
      );
      return parseInt(stdout.trim(), 10) || null;
    } catch {
      return null;
    }
  }

  const pollStartTime = performance.now();
  let pollNextCheckpoint = POLL_CHECKPOINT_SEC;

  // Write interval for polling soak
  const pollWriteInterval = setInterval(() => {
    const elapsed = (performance.now() - pollStartTime) / 1000;
    if (elapsed >= POLL_DURATION_SEC) return;

    pollGlobalSeq++;
    const seq = pollGlobalSeq;
    pollSendTimes.set(seq, performance.now());
    pollPsqlProc.stdin.write(`INSERT INTO p5_data (seq, payload) VALUES (${seq}, repeat('x', 50));\n`);
    pollTotalWritten++;
    pollWindowWritten++;
    pollWritesSinceCheckpoint++;
  }, 1000 / POLL_WRITES_PER_SEC);

  // Poll interval
  const pollTimer = setInterval(async () => {
    const maxSeq = await pollMaxSeq();
    const now = performance.now();
    if (maxSeq != null && maxSeq !== pollLastMaxSeq) {
      // Detect all seqs between old max and new max
      const oldMax = pollLastMaxSeq || 20000;
      for (let s = oldMax + 1; s <= maxSeq; s++) {
        if (pollSendTimes.has(s)) {
          const latency = now - pollSendTimes.get(s);
          pollWindowLatencies.push(latency);
          pollSendTimes.delete(s);
          pollTotalDelivered++;
        }
      }
      pollLastMaxSeq = maxSeq;
    }
  }, POLL_INTERVAL_MS);

  // Checkpoint loop for polling soak
  const pollCheckpointInterval = setInterval(() => {
    const elapsedSec = Math.round((performance.now() - pollStartTime) / 1000);
    if (elapsedSec < pollNextCheckpoint) return;

    const sorted = pollWindowLatencies.slice().sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? percentile(sorted, 50) : 0;
    const p95 = sorted.length > 0 ? percentile(sorted, 95) : 0;
    const p99 = sorted.length > 0 ? percentile(sorted, 99) : 0;

    pollCheckpoints.push({
      sec: pollNextCheckpoint,
      writes: pollTotalWritten,
      delivered: pollTotalDelivered,
      windowDelivered: sorted.length,
      windowWrites: pollWritesSinceCheckpoint,
      p50, p95, p99
    });

    console.log(
      `[${pad(pollNextCheckpoint, 3)}s] ` +
      `writes=${pad(pollTotalWritten, 5)}  ` +
      `delivered=${pad(pollTotalDelivered, 5)}  ` +
      `p50=${pad(fms(p50), 8)}  ` +
      `p95=${pad(fms(p95), 8)}  ` +
      `p99=${pad(fms(p99), 8)}`
    );

    pollWindowLatencies.length = 0;
    pollWritesSinceCheckpoint = 0;
    pollNextCheckpoint += POLL_CHECKPOINT_SEC;

    // Prune stale sendTimes
    const cutoff = performance.now() - 30000;
    for (const [k, v] of pollSendTimes) {
      if (v < cutoff) pollSendTimes.delete(k);
    }
  }, 1000);

  // Wait for polling duration + drain
  await new Promise(r => setTimeout(r, POLL_DURATION_SEC * 1000));
  clearInterval(pollWriteInterval);

  // Flush final checkpoint window
  if (pollWindowLatencies.length > 0 || pollWritesSinceCheckpoint > 0) {
    const sorted = pollWindowLatencies.slice().sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? percentile(sorted, 50) : 0;
    const p95 = sorted.length > 0 ? percentile(sorted, 95) : 0;
    const p99 = sorted.length > 0 ? percentile(sorted, 99) : 0;
    pollCheckpoints.push({
      sec: POLL_DURATION_SEC,
      writes: pollTotalWritten,
      delivered: pollTotalDelivered,
      windowDelivered: sorted.length,
      windowWrites: pollWritesSinceCheckpoint,
      p50, p95, p99
    });
    console.log(
      `[${pad(POLL_DURATION_SEC, 3)}s] ` +
      `writes=${pad(pollTotalWritten, 5)}  ` +
      `delivered=${pad(pollTotalDelivered, 5)}  ` +
      `p50=${pad(fms(p50), 8)}  ` +
      `p95=${pad(fms(p95), 8)}  ` +
      `p99=${pad(fms(p99), 8)}`
    );
  }

  // Drain period for polling
  await new Promise(r => setTimeout(r, DRAIN_SEC * 1000));
  clearInterval(pollTimer);
  clearInterval(pollCheckpointInterval);

  // Clean up polling write pipe
  pollPsqlProc.stdin.end();
  pollPsqlProc.kill();

  // Polling summary
  const pollLastCp = pollCheckpoints[pollCheckpoints.length - 1];
  const pollP50 = pollLastCp ? pollLastCp.p50 : 0;
  const pollP95 = pollLastCp ? pollLastCp.p95 : 0;
  const pollDeliveryRate = pollTotalWritten > 0 ? (pollTotalDelivered / pollTotalWritten) * 100 : 0;

  console.log('\n--- Polling Summary ---');
  console.log(`Delivery rate:     ${pollDeliveryRate.toFixed(1)}% (${pollTotalDelivered}/${pollTotalWritten})`);
  console.log(`Last window p50:   ${fms(pollP50)}`);
  console.log(`Last window p95:   ${fms(pollP95)}`);

  // Side-by-side comparison
  console.log('\n--- Polling vs pg_reactive ---');
  console.log('                 pg_reactive    polling_200ms');
  console.log(`p50:             ${fms(reactiveP50).padEnd(15)}${fms(pollP50)}`);
  console.log(`p95:             ${fms(reactiveP95).padEnd(15)}${fms(pollP95)}`);
  console.log(`delivery:        ${(reactiveDelivery.toFixed(1) + '%').padEnd(15)}${pollDeliveryRate.toFixed(1)}%`);

  // --- Cleanup ---
  for (const c of clients) c.ws.close();
  psqlProc.stdin.end();
  psqlProc.kill();

  try { psql("SELECT pgr.unsubscribe('p5_q')"); } catch { /* ignore */ }
  try { psql('DROP TABLE IF EXISTS p5_data CASCADE'); } catch { /* ignore */ }

  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error('P5 soak test error:', e);
  try { psql("SELECT pgr.unsubscribe('p5_q')"); } catch { /* ignore */ }
  try { psql('DROP TABLE IF EXISTS p5_data CASCADE'); } catch { /* ignore */ }
  process.exit(1);
});
