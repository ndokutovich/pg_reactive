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
 * All statements go through ONE psql process per scenario. Spawning
 * `docker compose exec` per statement costs ~400ms of Docker CLI overhead and
 * drowns the thing being measured; a trivial-statement run of the same shape
 * is subtracted so what remains is query work.
 *
 * Requires: docker compose up (db + proxy-go), port 8080, WS_MAX_PER_IP high.
 * Usage:    node tests/perf/p8_delta_vs_signal.mjs
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const N_UPDATES = Number(process.env.P8_UPDATES || 200);
const ROWS = Number(process.env.P8_ROWS || 10000);
const CLIENTS = (process.env.P8_CLIENTS || '1,10,50').split(',').map(Number);
const QUERY = "SELECT status, count(*) FROM perf_dvs GROUP BY status";
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

const { default: WebSocket } = await import('ws');

/** Run a batch of statements through one psql process; returns elapsed ms. */
function runSql(statements) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const p = spawn(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-q'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let err = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `psql exit ${code}`));
      resolve(performance.now() - t0);
    });
    p.stdin.end(statements.join(';\n') + ';\n');
  });
}

function sql(statement) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', statement],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim()));
  });
}

function updates(n) {
  return Array.from({ length: n }, (_, i) =>
    `UPDATE perf_dvs SET status = 'u${i % 7}' WHERE id = ${(i * 37) % ROWS + 1}`
  );
}

const repeat = (n, s) => Array.from({ length: n }, () => s);

/** Server-side execution time of the query, median of five. */
async function queryCost() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const raw = await sql(`EXPLAIN (ANALYZE, FORMAT JSON) ${QUERY}`);
    samples.push(JSON.parse(raw)[0]['Execution Time']);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

// Clients bind to a query through the URL path (/ws/<query_id>), exactly as
// tests/perf/p3 does — there is no subscribe message on the wire.
function openWs(queryId) {
  return new WebSocket(`ws://127.0.0.1:8080/ws/${queryId}`, {
    headers: { Authorization: `Bearer ${ANON_KEY}` },
  });
}

function collect(queryId, kind, timeoutMs = 15000) {
  const ws = openWs(queryId);
  const seen = { deltas: 0, invalidations: 0 };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeoutMs);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribed') { clearTimeout(timer); resolve(); return; }
      if (kind === 'delta' && !m.type && m.query_id === queryId) seen.deltas++;
      if (kind === 'signal' && m.type === 'invalidated' && m.query_id === queryId) seen.invalidations++;
    });
    ws.on('error', reject);
  });
  return { ws, seen, ready };
}

const wait = (n) => new Promise((r) => setTimeout(r, n));

async function recomputes() {
  return Number(await sql("SELECT value FROM pgr.stats() WHERE metric = 'total_recomputes'"));
}

async function main() {
  console.log('=== P8: delta vs signal + re-query ===');
  console.log(`rows=${ROWS} updates=${N_UPDATES} clients=${CLIENTS.join(',')}`);

  await sql('DROP TABLE IF EXISTS perf_dvs CASCADE');
  await sql('DROP EXTENSION IF EXISTS pg_reactive CASCADE');
  await sql('CREATE EXTENSION pg_reactive');
  await sql('CREATE TABLE perf_dvs (id serial PRIMARY KEY, status text)');
  await sql(`INSERT INTO perf_dvs (status) SELECT 's' || (g % 7) FROM generate_series(1, ${ROWS}) g`);
  await sql('ANALYZE perf_dvs');

  const qCost = await queryCost();
  console.log(`query cost (server side, median of 5): ${qCost.toFixed(2)} ms`);

  // Same-shape run of trivial statements: Docker exec + psql startup, no query.
  const floor = await runSql(repeat(N_UPDATES, 'SELECT 1'));
  console.log(`harness floor (${N_UPDATES} trivial statements): ${floor.toFixed(1)} ms`);

  // ── delta mode ────────────────────────────────────────────────────────────
  await sql(`SELECT pgr.subscribe('dvs_delta', $$${QUERY}$$, 'delta')`);
  await wait(300);

  const r0 = await recomputes();
  const maxClients = Math.max(...CLIENTS);
  const deltaClients = Array.from({ length: maxClients }, () => collect('dvs_delta', 'delta'));
  await Promise.all(deltaClients.map((c) => c.ready));

  const deltaWall = await runSql(updates(N_UPDATES));
  await wait(Math.max(2000, N_UPDATES * 40));
  const r1 = await recomputes();

  // One extra delta arrives on subscribe (the initial snapshot), so the check
  // is "at least N" — a lost delta would put a client below N.
  const perClient = deltaClients.map((c) => c.seen.deltas);
  const allDelivered = perClient.every((n) => n >= N_UPDATES);
  deltaClients.forEach((c) => c.ws.close());

  console.log('');
  console.log('delta mode');
  console.log(`  recomputes:        ${r1 - r0}  (expected ${N_UPDATES})`);
  console.log(`  wall:              ${deltaWall.toFixed(1)} ms  (floor ${floor.toFixed(1)})`);
  console.log(`  deltas per client: ${perClient.slice(0, 5).join('/')}${maxClients > 5 ? '/…' : ''}  ${allDelivered ? '(all N)' : '(MISMATCH)'}`);

  // ── signal mode ───────────────────────────────────────────────────────────
  await sql("SELECT pgr.unsubscribe('dvs_delta')");
  await sql(`SELECT pgr.subscribe('dvs_signal', $$${QUERY}$$, 'notify')`);
  await wait(300);

  const sig = collect('dvs_signal', 'signal');
  await sig.ready;
  const signalWall = await runSql(updates(N_UPDATES));
  await wait(Math.max(2000, N_UPDATES * 40));
  sig.ws.close();

  console.log('');
  console.log('signal mode');
  console.log(`  invalidations:     ${sig.seen.invalidations}  (expected ${N_UPDATES})`);
  console.log(`  wall:              ${signalWall.toFixed(1)} ms  (floor ${floor.toFixed(1)})`);

  // ── the bill the signal leaves with the client ────────────────────────────
  console.log('');
  console.log('client re-query cost (the work delta mode removes)');
  console.log('  clients │ queries │   query time │ per update');
  console.log('  ────────┼─────────┼──────────────┼───────────');
  const rows = [];
  for (const m of CLIENTS) {
    const count = N_UPDATES * m;
    const real = await runSql(repeat(count, QUERY));
    const triv = await runSql(repeat(count, 'SELECT 1'));
    const net = Math.max(real - triv, 0);
    const perUpdate = net / N_UPDATES;
    rows.push({ clients: m, queries: count, ms: net, perUpdate });
    console.log(
      `  ${String(m).padStart(7)} │ ${String(count).padStart(7)} │ ${net.toFixed(1).padStart(9)} ms │ ${perUpdate.toFixed(2).padStart(7)} ms`
    );
  }

  // ── many distinct subscriptions on the same table ─────────────────────────
  // The fan-out case above is the shape pg_reactive is built for: one query,
  // many subscribers. The opposite shape is one subscriber per predicate — a
  // per-user query. Dependencies are tracked per table and column, not per row,
  // so a write to one user's row invalidates every subscription reading that
  // table. This measures how much that costs.
  console.log('');
  console.log('many subscriptions on one table (the shape where this can lose)');
  await sql('DROP TABLE IF EXISTS perf_dvs_users');
  await sql('CREATE TABLE perf_dvs_users (id serial PRIMARY KEY, status text)');
  await sql(`INSERT INTO perf_dvs_users (status) SELECT 's' || (g % 7) FROM generate_series(1, ${ROWS}) g`);

  const many = Math.min(Math.max(...CLIENTS), 50) || 10;
  for (let i = 0; i < many; i++) {
    await sql(`SELECT pgr.subscribe('dvs_u${i}', $$SELECT count(*) FROM perf_dvs_users WHERE id = ${i + 1}$$, 'delta')`);
  }
  await wait(500);

  const before = await recomputes();
  // Each statement touches one row; every subscription on the table invalidates.
  const manyWall = await runSql(
    Array.from({ length: N_UPDATES }, (_, i) => `UPDATE perf_dvs_users SET status = 'x' WHERE id = ${i + 1}`)
  );
  await wait(Math.max(2000, N_UPDATES * 40));
  const after = await recomputes();

  // The same work the re-query model would do: N updates x M plain SELECTs.
  const equivalent = Array.from({ length: N_UPDATES }, () =>
    Array.from({ length: many }, (_, i) => `SELECT count(*) FROM perf_dvs_users WHERE id = ${i + 1}`).join('; ')
  ).join(';\n');
  const requeryWall = await runSql([equivalent]);
  const requeryFloor = await runSql(repeat(many * N_UPDATES, 'SELECT 1'));

  const recomputeNet = Math.max(manyWall - floor, 0);
  const requeryNet = Math.max(requeryWall - requeryFloor, 0);
  const ops = many * N_UPDATES;

  console.log(`  subscriptions:     ${many}`);
  console.log(`  updates:           ${N_UPDATES}`);
  console.log(`  recomputes:        ${after - before}  (a plain re-query model would run ${many} queries per update = ${ops})`);
  console.log(`  our time:          ${recomputeNet.toFixed(1)} ms net  (${(recomputeNet / ops).toFixed(3)} ms per recompute)`);
  console.log(`  re-query time:     ${requeryNet.toFixed(1)} ms net  (${(requeryNet / ops).toFixed(3)} ms per query)`);
  console.log(`  ratio:             ${(recomputeNet / Math.max(requeryNet, 1e-9)).toFixed(2)}x  (above 1 = we lose this shape)`);

  for (let i = 0; i < many; i++) await sql(`SELECT pgr.unsubscribe('dvs_u${i}')`);
  await sql('DROP TABLE perf_dvs_users');

  const deltaOverhead = Math.max(deltaWall - floor, 0);
  const perUpdateDelta = deltaOverhead / N_UPDATES;
  // Per-query cost from the largest client count: net time there is tens of
  // times the harness floor, so it survives the subtraction. At one client the
  // net is a difference of two ~450ms runs and swings by 3x between runs.
  const biggest = rows[rows.length - 1];
  const perQuery = biggest.ms / biggest.queries;
  const breakEven = perUpdateDelta / Math.max(perQuery, 1e-9);

  console.log('');
  console.log('=== verdict ===');
  console.log(`delta:  ${r1 - r0} recomputes for ${N_UPDATES} updates, shared by every client — O(N)`);
  console.log(`signal: 0 recomputes, but ${N_UPDATES}xM queries — O(N*M)`);
  console.log(`delta overhead per update:        ${perUpdateDelta.toFixed(2)} ms`);
  console.log(`one re-query (from ${biggest.clients} clients):     ${perQuery.toFixed(2)} ms`);
  console.log(`break-even at ~${breakEven.toFixed(1)} clients`);
  console.log(breakEven < 1
    ? 'PASS — delta pays for itself from the first client'
    : `NOTE — delta only wins above ${breakEven.toFixed(1)} clients`);

  await sql("SELECT pgr.unsubscribe('dvs_signal')");
  await sql('DROP TABLE perf_dvs CASCADE');
  process.exit(0);
}

main().catch((e) => {
  console.error('P8 failed:', e.message);
  process.exit(2);
});
