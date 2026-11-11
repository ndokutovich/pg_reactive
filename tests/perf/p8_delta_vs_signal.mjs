#!/usr/bin/env node
/**
 * P8 — delta delivery vs signal + re-query.
 *
 * Comparing pg_reactive's notification rate against a bare LISTEN/NOTIFY is
 * apples to oranges. A NOTIFY carrying a signal tells the consumer that
 * *something* changed; the consumer must then run the query itself to learn
 * what. pg_reactive sends the delta, so the consumer re-runs nothing.
 *
 * This benchmark measures the work each model puts on the database to keep M
 * clients correct across N updates of the same subscribed query:
 *
 *   delta   N updates -> N recomputes, shared by every subscriber   = O(N)
 *   signal  N updates -> each client re-runs the query              = O(N*M)
 *
 * Requires: docker compose up (db + proxy-go), port 8080.
 * Usage:    node tests/perf/p8_delta_vs_signal.mjs
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const N_UPDATES = 50;
const ROWS = Number(process.env.P8_ROWS || 10000);
const CLIENTS = (process.env.P8_CLIENTS || '1,10,50').split(',').map(Number);
const QUERY = "SELECT status, count(*) FROM perf_dvs GROUP BY status";

const { default: WebSocket } = await import('ws');

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

function ms(fn) {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

/** Server-side execution time of the query, median of five. */
function queryCost() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const raw = psql(`EXPLAIN (ANALYZE, FORMAT JSON) ${QUERY}`);
    samples.push(JSON.parse(raw)[0]['Execution Time']);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

/** N updates that each change one row's status — the trigger path. */
function applyUpdates(n) {
  return psql(
    Array.from({ length: n }, (_, i) =>
      `UPDATE perf_dvs SET status = 'u${i % 7}' WHERE id = ${(i * 37) % ROWS + 1}`
    ).join('; ')
  );
}

/** The re-query a signal-only consumer must issue, N*M times, in one session. */
function rerunQueries(count) {
  return psql(Array.from({ length: count }, () => QUERY).join('; '));
}

async function deltaClient(queryId, timeoutMs = 10000) {
  const ws = new WebSocket('ws://127.0.0.1:8080');
  const deltas = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', query_id: queryId }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribed') { clearTimeout(timer); resolve(); }
      if (!m.type && m.query_id === queryId) deltas.push(m);
    });
    ws.on('error', reject);
  });
  return { ws, deltas };
}

async function signalClient(queryId, invalidations, timeoutMs = 10000) {
  const ws = new WebSocket('ws://127.0.0.1:8080');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', query_id: queryId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribed') { clearTimeout(timer); resolve(); }
      if (m.type === 'invalidated' && m.query_id === queryId) invalidations.push(m);
    });
    ws.on('error', reject);
  });
  return ws;
}

function recomputes() {
  const rows = psql("SELECT value FROM pgr.stats() WHERE metric = 'total_recomputes'");
  return Number(rows);
}

const wait = (n) => new Promise((r) => setTimeout(r, n));

async function main() {
  console.log('=== P8: delta vs signal + re-query ===');
  console.log(`rows=${ROWS} updates=${N_UPDATES} clients=${CLIENTS.join(',')}`);

  psql('DROP TABLE IF EXISTS perf_dvs CASCADE');
  psql('CREATE TABLE perf_dvs (id serial PRIMARY KEY, status text)');
  psql(`INSERT INTO perf_dvs (status) SELECT 's' || (g % 7) FROM generate_series(1, ${ROWS}) g`);
  psql('ANALYZE perf_dvs');

  const qCost = queryCost();
  console.log(`query cost (server side, median of 5): ${qCost.toFixed(2)} ms`);

  // Baseline: the writes themselves, with nothing subscribed.
  psql("SELECT pgr.unsubscribe('dvs_delta')");
  psql("SELECT pgr.unsubscribe('dvs_signal')");
  let t = ms(() => applyUpdates(N_UPDATES));
  const baseMs = t.ms;
  console.log(`baseline: ${N_UPDATES} updates, no subscription: ${baseMs.toFixed(1)} ms`);

  // ── delta mode ────────────────────────────────────────────────────────────
  psql(`SELECT pgr.subscribe('dvs_delta', $$${QUERY}$$, 'delta')`);
  await wait(300);

  const r0 = recomputes();
  const clients = await Promise.all(
    Array.from({ length: Math.max(...CLIENTS) }, () => deltaClient('dvs_delta'))
  );
  t = ms(() => applyUpdates(N_UPDATES));
  await wait(Math.max(1500, N_UPDATES * 30));
  const deltaMs = t.ms;
  const r1 = recomputes();

  const perClient = clients.map((c) => c.deltas.length);
  const gotAll = perClient.every((n) => n === N_UPDATES);
  clients.forEach((c) => c.ws.close());

  console.log('');
  console.log('delta mode');
  console.log(`  recomputes:        ${r1 - r0}  (expected ${N_UPDATES})`);
  console.log(`  wall:              ${deltaMs.toFixed(1)} ms (baseline ${baseMs.toFixed(1)} → overhead ${(deltaMs - baseMs).toFixed(1)})`);
  console.log(`  deltas per client: ${perClient.join('/')}  ${gotAll ? '(all N)' : '(MISMATCH)'}`);

  // ── signal mode ───────────────────────────────────────────────────────────
  psql("SELECT pgr.unsubscribe('dvs_delta')");
  psql(`SELECT pgr.subscribe('dvs_signal', $$${QUERY}$$, 'notify')`);
  await wait(300);

  const invalidations = [];
  const sigWs = await signalClient('dvs_signal', invalidations);
  t = ms(() => applyUpdates(N_UPDATES));
  await wait(Math.max(1500, N_UPDATES * 30));
  const signalMs = t.ms;
  sigWs.close();

  console.log('');
  console.log('signal mode');
  console.log(`  invalidations:     ${invalidations.length}  (expected ${N_UPDATES})`);
  console.log(`  wall:              ${signalMs.toFixed(1)} ms (no recompute in the database)`);

  // ── the bill the signal leaves with the client ────────────────────────────
  console.log('');
  console.log('client re-query cost (the work delta mode removes)');
  console.log('  clients │ queries │ db work (measured) │ per update');
  console.log('  ────────┼─────────┼────────────────────┼───────────');
  const rows = [];
  for (const m of CLIENTS) {
    const count = N_UPDATES * m;
    const r = ms(() => rerunQueries(count));
    const perUpdate = r.ms / N_UPDATES;
    rows.push({ clients: m, queries: count, ms: r.ms, perUpdate });
    console.log(
      `  ${String(m).padStart(7)} │ ${String(count).padStart(7)} │ ${r.ms.toFixed(1).padStart(15)} ms │ ${perUpdate.toFixed(2).padStart(7)} ms`
    );
  }

  const deltaOverhead = deltaMs - baseMs;
  const breakEven = rows[0] ? deltaOverhead / Math.max(rows[0].perUpdate, 1e-9) : 1;

  console.log('');
  console.log('=== verdict ===');
  console.log(`delta:  ${(r1 - r0)} recomputes for ${N_UPDATES} updates, shared by every client — O(N)`);
  console.log(`signal: 0 recomputes, but ${N_UPDATES}xM queries — O(N*M)`);
  console.log(`delta overhead per update: ${(deltaOverhead / N_UPDATES).toFixed(2)} ms`);
  console.log(`signal re-query per update (per client): ${(rows[0]?.perUpdate ?? 0).toFixed(2)} ms`);
  console.log(`break-even at ~${breakEven.toFixed(2)} clients`);
  if (breakEven < 1) {
    console.log('PASS — delta pays for itself from the first client');
  } else {
    console.log(`FAIL — delta only wins above ${breakEven.toFixed(1)} clients`);
  }

  psql("SELECT pgr.unsubscribe('dvs_signal')");
  psql('DROP TABLE perf_dvs CASCADE');
  process.exit(breakEven < 1 ? 0 : 1);
}

main().catch((e) => {
  console.error('P8 failed:', e.message);
  process.exit(2);
});
