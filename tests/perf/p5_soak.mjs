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
import { execFileSync, spawn } from 'child_process';
import { performance } from 'perf_hooks';

const WS_URL = 'ws://127.0.0.1:8080/ws/p5_q';
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
  const ws = new WebSocket(WS_URL);
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
