/**
 * S6: Fan-out Delivery Latency Benchmark
 *
 * Measures how long it takes for N WebSocket clients to ALL receive the same
 * change notification after a single INSERT.  Captures both first-client and
 * last-client latencies across multiple client counts.
 *
 * This scenario targets the pg_reactive WebSocket proxy exclusively.
 */

import WebSocket from 'ws';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, '..', 'results', 'raw');

const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1';
const PROXY_PORT = process.env.PROXY_PORT || '28080';
const QUERY_ID = 'fanout_bench';
const PROXY_URL = `ws://${PROXY_HOST}:${PROXY_PORT}/ws/${QUERY_ID}`;

const COMPOSE_FILE = process.env.COMPOSE_FILE || 'bench/docker-compose.bench.yml';
const DB_SERVICE = process.env.DB_SERVICE || 'bench-db';
const DB_NAME = process.env.DB_NAME || 'bench_db';

const CLIENT_COUNTS = [1, 10, 50, 100];
const ITERATIONS = 20;
const CONNECT_DELAY_MS = 50;
const RECEIVE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function psql(sql) {
  try {
    return execFileSync(
      'docker',
      [
        'compose', '-f', COMPOSE_FILE,
        'exec', '-T', DB_SERVICE,
        'psql', '-U', 'postgres', '-d', DB_NAME, '-t', '-A', '-c', sql,
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    ).trim();
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`psql failed: ${msg}`);
  }
}

/**
 * Compute a percentile from an already-sorted array using nearest-rank.
 */
function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// WebSocket client helpers
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket connection and wait for the open event.
 * Returns { ws, received } where `received` is a mutable array of parsed
 * messages accumulated by the on-message handler.
 */
function connectClient(index) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(PROXY_URL);
    const received = [];

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Client ${index}: connection timeout`));
    }, 10_000);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.on('message', (data) => {
        received.push(JSON.parse(data.toString()));
      });
      resolve({ ws, received, index });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Client ${index}: ${err.message}`));
    });
  });
}

/**
 * Wait until a client's received array contains the subscribed welcome message.
 */
function waitForSubscribed(client, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;

    const check = () => {
      const found = client.received.find(
        (m) => m.type === 'subscribed' && m.query_id === QUERY_ID,
      );
      if (found) return resolve();
      if (performance.now() > deadline) {
        return reject(new Error(`Client ${client.index}: subscribed timeout`));
      }
      setTimeout(check, 50);
    };

    check();
  });
}

/**
 * Returns a promise that resolves with { firstMs, lastMs } relative to t0 when
 * ALL clients have received a delta message for the given query_id, or rejects
 * on timeout.
 *
 * Each client is checked by polling its `received` array for a delta that
 * arrived AFTER the `bufferClearMark` (the length at the time of clearing).
 */
function waitForAllDeltas(clients, t0, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = t0 + timeoutMs;
    const clientCount = clients.length;
    const arrivedAt = new Array(clientCount).fill(0); // ms timestamps
    let firstMs = 0;
    let arrivedCount = 0;

    const check = () => {
      const now = performance.now();

      for (let i = 0; i < clientCount; i++) {
        if (arrivedAt[i] > 0) continue; // already recorded

        const c = clients[i];
        const delta = c.received.find(
          (m, idx) => idx >= c._bufferMark && m.query_id === QUERY_ID && m.inserted,
        );

        if (delta) {
          arrivedAt[i] = now;
          arrivedCount++;
          if (arrivedCount === 1) firstMs = now - t0;
        }
      }

      if (arrivedCount === clientCount) {
        const lastMs = Math.max(...arrivedAt.map((t) => t - t0));
        return resolve({ firstMs, lastMs });
      }

      if (now > deadline) {
        return reject(
          new Error(
            `Timeout: ${arrivedCount}/${clientCount} clients received delta`,
          ),
        );
      }

      // Poll rapidly (1ms) to capture timing accurately.
      setTimeout(check, 1);
    };

    check();
  });
}

// ---------------------------------------------------------------------------
// Scenario runner for a single client count
// ---------------------------------------------------------------------------

async function runForClientCount(numClients) {
  console.error(`\n--- N=${numClients} ---`);

  // Setup table and subscription
  psql('CREATE TABLE IF NOT EXISTS fanout_bench(id serial PRIMARY KEY, val int)');
  psql('TRUNCATE fanout_bench');
  psql(
    `SELECT pgr.subscribe('${QUERY_ID}', 'SELECT id, val FROM fanout_bench')`,
  );

  // Connect clients sequentially with a small delay
  const clients = [];
  for (let i = 0; i < numClients; i++) {
    const client = await connectClient(i);
    clients.push(client);
    if (i < numClients - 1) await sleep(CONNECT_DELAY_MS);
  }
  console.error(`  Connected ${numClients} clients`);

  // Wait for all subscribed messages
  await Promise.all(clients.map((c) => waitForSubscribed(c)));
  console.error(`  All clients received subscribed confirmation`);

  // Run iterations
  const allLatencies = [];
  const firstLatencies = [];
  let misses = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Mark current buffer length so we only look at new messages
    for (const c of clients) {
      c._bufferMark = c.received.length;
    }

    const t0 = performance.now();

    // Fire the INSERT from the host via docker exec
    psql(`INSERT INTO fanout_bench(val) VALUES (${iter})`);

    try {
      const { firstMs, lastMs } = await waitForAllDeltas(
        clients,
        t0,
        RECEIVE_TIMEOUT_MS,
      );
      allLatencies.push(lastMs);
      firstLatencies.push(firstMs);
    } catch {
      misses++;
    }

    // Progress reporting every 5 iterations and on the last one
    if ((iter + 1) % 5 === 0 || iter + 1 === ITERATIONS) {
      const sortedAll = [...allLatencies].sort((a, b) => a - b);
      const p50 = percentile(sortedAll, 50);
      console.error(
        `  N=${numClients}: iteration ${iter + 1}/${ITERATIONS}, ` +
          `last-client p50=${p50.toFixed(1)}ms, misses=${misses}`,
      );
    }
  }

  // Close all connections
  for (const c of clients) {
    c.ws.close();
  }

  // Teardown
  try {
    psql(`SELECT pgr.unsubscribe('${QUERY_ID}')`);
  } catch {
    // Ignore cleanup errors
  }
  try {
    psql('DROP TABLE IF EXISTS fanout_bench');
  } catch {
    // Ignore cleanup errors
  }

  // Compute statistics
  const sortedAll = [...allLatencies].sort((a, b) => a - b);
  const sortedFirst = [...firstLatencies].sort((a, b) => a - b);

  return {
    clients: numClients,
    all_latencies_ms: allLatencies.map((v) => Math.round(v * 100) / 100),
    first_latencies_ms: firstLatencies.map((v) => Math.round(v * 100) / 100),
    p50_all_ms: Math.round(percentile(sortedAll, 50) * 100) / 100,
    p95_all_ms: Math.round(percentile(sortedAll, 95) * 100) / 100,
    p50_first_ms: Math.round(percentile(sortedFirst, 50) * 100) / 100,
    p95_first_ms: Math.round(percentile(sortedFirst, 95) * 100) / 100,
    misses,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error('=== S6: Fan-out Delivery Latency ===');
  console.error(`Proxy: ${PROXY_URL}`);
  console.error(`Client counts: [${CLIENT_COUNTS.join(', ')}]`);
  console.error(`Iterations per count: ${ITERATIONS}`);

  // Verify proxy is reachable by attempting a quick connection
  try {
    const probe = new WebSocket(PROXY_URL);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        probe.terminate();
        reject(new Error('Proxy connection timeout'));
      }, 5_000);
      probe.on('open', () => {
        clearTimeout(timer);
        probe.close();
        resolve();
      });
      probe.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`ERROR: Cannot reach proxy at ${PROXY_URL}: ${err.message}`);
    console.error('Make sure the bench-proxy service is running.');
    process.exit(1);
  }

  console.error('Proxy reachable. Starting benchmark...\n');

  // Ensure the extension is loaded
  try {
    psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');
  } catch {
    // May already exist
  }

  const results = [];

  for (const count of CLIENT_COUNTS) {
    try {
      const result = await runForClientCount(count);
      results.push(result);

      console.error(
        `  => N=${count}: p50_all=${result.p50_all_ms}ms ` +
          `p95_all=${result.p95_all_ms}ms ` +
          `p50_first=${result.p50_first_ms}ms ` +
          `misses=${result.misses}`,
      );
    } catch (err) {
      console.error(`  => N=${count}: FAILED - ${err.message}`);
      results.push({
        clients: count,
        all_latencies_ms: [],
        first_latencies_ms: [],
        p50_all_ms: 0,
        p95_all_ms: 0,
        p50_first_ms: 0,
        p95_first_ms: 0,
        misses: ITERATIONS,
        error: err.message,
      });
    }

    // Brief pause between client counts to let the proxy settle
    await sleep(1000);
  }

  // Write results
  const output = {
    scenario: 's6_fanout',
    approach: 'pg_reactive',
    client_counts: CLIENT_COUNTS,
    iterations: ITERATIONS,
    results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outputPath = resolve(RESULTS_DIR, 's6_fanout.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

  console.error(`\nResults written to ${outputPath}`);

  // Print summary table to stderr
  console.error('\n--- Summary ---');
  console.error(
    'Clients | p50_all | p95_all | p50_first | p95_first | Misses',
  );
  console.error(
    '--------|---------|---------|-----------|-----------|-------',
  );
  for (const r of results) {
    console.error(
      `${String(r.clients).padStart(7)} | ` +
        `${String(r.p50_all_ms).padStart(7)}ms | ` +
        `${String(r.p95_all_ms).padStart(7)}ms | ` +
        `${String(r.p50_first_ms).padStart(9)}ms | ` +
        `${String(r.p95_first_ms).padStart(9)}ms | ` +
        `${r.misses}`,
    );
  }

  // Also write JSON to stdout for pipeline consumption
  console.log(JSON.stringify(output, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
