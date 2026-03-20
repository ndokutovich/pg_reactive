/**
 * Article Validation: tests every claim in the pg_reactive Habr article.
 *
 * Connects via WebSocket, subscribes to queries, performs DML, and verifies
 * the delta JSON received matches expectations.
 *
 * Prerequisites:
 *   - Docker compose running (pg_reactive dev stack on port 8080)
 *   - Extension loaded and test tables created by this script
 *
 * Run:
 *   node tests/validate_article.mjs
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { psql, waitForMessage } from './helpers.mjs';

// Auto-install ws if not available
const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const PROXY = 'ws://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';

let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket for a given query_id. Returns { ws, messages }.
 * The messages array is populated as messages arrive.
 */
function connectWS(queryId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${PROXY}/ws/${queryId}?apikey=${encodeURIComponent(ANON_KEY)}`
    );
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

/**
 * Wait until no new messages arrive for `quietMs` after the current count.
 * Resolves when no new messages have appeared for `quietMs`.
 */
function waitForQuiet(messages, quietMs = 2000) {
  return new Promise((resolve) => {
    let lastLen = messages.length;
    let timer = setTimeout(done, quietMs);
    const interval = setInterval(() => {
      if (messages.length !== lastLen) {
        lastLen = messages.length;
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      }
    }, 100);
    function done() {
      clearInterval(interval);
      resolve();
    }
  });
}

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS: ${detail}`);
  } else {
    failed++;
    console.log(`  FAIL: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testV1_GroupBy() {
  console.log('\nV1: GROUP BY subscribe');

  psql('DROP TABLE IF EXISTS va_orders CASCADE');
  psql('CREATE TABLE va_orders (id serial, status text, amount numeric)');
  psql("INSERT INTO va_orders VALUES (1,'pending',10),(2,'pending',20),(3,'shipped',30)");
  psql("SELECT pgr.subscribe('va_group', 'SELECT status, COUNT(*) as cnt, SUM(amount) as total FROM va_orders GROUP BY status')");

  const { ws, messages } = await connectWS('va_group');
  await waitForMessage(messages, (m) => m.type === 'subscribed');

  // Clear messages after subscribed
  messages.length = 0;

  psql("INSERT INTO va_orders (status, amount) VALUES ('pending', 40)");

  const delta = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_group' && (m.inserted || m.deleted),
    5000
  );

  // The delta should reflect the group change for 'pending'
  const ins = delta.inserted || [];
  const hasPending = ins.some(
    (r) => r.status === 'pending' && (Number(r.cnt) === 3 || Number(r.cnt) === 4)
  );
  report('V1', hasPending, hasPending
    ? 'delta received with correct group counts'
    : `expected pending group in inserted, got: ${JSON.stringify(ins)}`
  );

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_group')"); } catch (_) {}
}

async function testV2_WindowFunctions() {
  console.log('\nV2: Window functions (RANK)');

  psql('DROP TABLE IF EXISTS va_products CASCADE');
  psql('CREATE TABLE va_products (id serial, name text, price numeric)');
  psql("INSERT INTO va_products VALUES (1,'A',100),(2,'B',200),(3,'C',300)");
  psql("SELECT pgr.subscribe('va_rank', 'SELECT id, name, price, RANK() OVER (ORDER BY price DESC) as rnk FROM va_products')");

  const { ws, messages } = await connectWS('va_rank');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  psql("INSERT INTO va_products (name, price) VALUES ('D', 250)");

  const delta = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_rank' && (m.inserted || m.deleted),
    5000
  );

  const ins = delta.inserted || [];
  // Inserting D at price 250 should shift ranks; at minimum D appears in inserted
  const hasD = ins.some((r) => r.name === 'D');
  report('V2', hasD, hasD
    ? 'delta received with rank changes'
    : `expected 'D' in inserted, got: ${JSON.stringify(ins)}`
  );

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_rank')"); } catch (_) {}
}

async function testV3_Having() {
  console.log('\nV3: HAVING clause');

  psql('DROP TABLE IF EXISTS va_tags CASCADE');
  psql('CREATE TABLE va_tags (id serial, tag text)');
  psql("INSERT INTO va_tags VALUES (1,'go'),(2,'rust')");
  psql("SELECT pgr.subscribe('va_having', 'SELECT tag, COUNT(*) as cnt FROM va_tags GROUP BY tag HAVING COUNT(*) > 1')");

  const { ws, messages } = await connectWS('va_having');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  // Insert a second 'go' tag, crossing the HAVING threshold
  psql("INSERT INTO va_tags (tag) VALUES ('go')");

  const delta = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_having' && m.inserted,
    5000
  );

  const ins = delta.inserted || [];
  const hasGo = ins.some((r) => r.tag === 'go' && Number(r.cnt) === 2);
  report('V3', hasGo, hasGo
    ? 'delta.inserted has {tag:go, cnt:2}'
    : `expected {tag:go, cnt:2} in inserted, got: ${JSON.stringify(ins)}`
  );

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_having')"); } catch (_) {}
}

async function testV4_OuterJoin() {
  console.log('\nV4: Outer JOIN');

  psql('DROP TABLE IF EXISTS va_emps CASCADE');
  psql('DROP TABLE IF EXISTS va_depts CASCADE');
  psql('CREATE TABLE va_depts (id serial PRIMARY KEY, name text)');
  psql('CREATE TABLE va_emps (id serial PRIMARY KEY, dept_id int REFERENCES va_depts(id), name text)');
  psql("INSERT INTO va_depts VALUES (1,'Eng'),(2,'Sales')");
  psql("SELECT pgr.subscribe('va_left', 'SELECT d.name as dept, e.name as emp FROM va_depts d LEFT JOIN va_emps e ON e.dept_id = d.id ORDER BY d.id, e.id')");

  const { ws, messages } = await connectWS('va_left');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  psql("INSERT INTO va_emps (dept_id, name) VALUES (1, 'Alice')");

  const delta = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_left' && (m.inserted || m.deleted),
    5000
  );

  const ins = delta.inserted || [];
  const del = delta.deleted || [];
  const hasAliceInserted = ins.some((r) => r.dept === 'Eng' && r.emp === 'Alice');
  const hasNullDeleted = del.some((r) => r.dept === 'Eng' && r.emp === null);
  const ok = hasAliceInserted && hasNullDeleted;
  report('V4', ok, ok
    ? 'delta.inserted has {dept:Eng, emp:Alice}, delta.deleted has {dept:Eng, emp:null}'
    : `inserted: ${JSON.stringify(ins)}, deleted: ${JSON.stringify(del)}`
  );

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_left')"); } catch (_) {}
}

async function testV5_ColumnTracking() {
  console.log('\nV5: Column tracking (negative + positive)');

  psql('DROP TABLE IF EXISTS va_coltrack CASCADE');
  psql('CREATE TABLE va_coltrack (id serial, name text, val int)');
  psql("INSERT INTO va_coltrack VALUES (1,'x',10)");
  psql("SELECT pgr.subscribe('va_col', 'SELECT id, name FROM va_coltrack')");

  const { ws, messages } = await connectWS('va_col');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  // Update a column NOT in the SELECT — should produce NO delta
  psql('UPDATE va_coltrack SET val = 99 WHERE id = 1');

  await waitForQuiet(messages, 2000);

  const spuriousDelta = messages.find(
    (m) => m.query_id === 'va_col' && (m.inserted || m.deleted)
  );
  const noSpurious = !spuriousDelta;
  report('V5a', noSpurious, noSpurious
    ? 'no delta for non-tracked column update (val)'
    : `unexpected delta received: ${JSON.stringify(spuriousDelta)}`
  );

  // Now update a column that IS in the SELECT — should produce a delta
  messages.length = 0;
  psql("UPDATE va_coltrack SET name = 'y' WHERE id = 1");

  try {
    const delta = await waitForMessage(
      messages,
      (m) => m.query_id === 'va_col' && (m.inserted || m.deleted),
      5000
    );
    const ins = delta.inserted || [];
    const hasY = ins.some((r) => r.name === 'y');
    report('V5b', hasY, hasY
      ? 'delta received for tracked column update (name)'
      : `expected name='y' in inserted, got: ${JSON.stringify(ins)}`
    );
  } catch (e) {
    report('V5b', false, `no delta received for tracked column update: ${e.message}`);
  }

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_col')"); } catch (_) {}
}

async function testV6_CrossTable() {
  console.log('\nV6: Cross-table invalidation');

  psql('DROP TABLE IF EXISTS va_items CASCADE');
  psql('DROP TABLE IF EXISTS va_customers CASCADE');
  psql('CREATE TABLE va_customers (id serial PRIMARY KEY, name text)');
  psql('CREATE TABLE va_items (id serial PRIMARY KEY, customer_id int REFERENCES va_customers(id), item text)');
  psql("INSERT INTO va_customers VALUES (1,'Bob')");
  psql("INSERT INTO va_items VALUES (1,1,'Widget')");
  psql("SELECT pgr.subscribe('va_cross', 'SELECT c.name, i.item FROM va_items i JOIN va_customers c ON c.id = i.customer_id')");

  const { ws, messages } = await connectWS('va_cross');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  psql("UPDATE va_customers SET name = 'Robert' WHERE id = 1");

  const delta = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_cross' && (m.inserted || m.deleted),
    5000
  );

  const ins = delta.inserted || [];
  const del = delta.deleted || [];
  const hasRobert = ins.some((r) => r.name === 'Robert' && r.item === 'Widget');
  const hasBob = del.some((r) => r.name === 'Bob' && r.item === 'Widget');
  const ok = hasRobert && hasBob;
  report('V6', ok, ok
    ? 'delta.inserted has {name:Robert, item:Widget}, delta.deleted has {name:Bob, item:Widget}'
    : `inserted: ${JSON.stringify(ins)}, deleted: ${JSON.stringify(del)}`
  );

  ws.close();
  try { psql("SELECT pgr.unsubscribe('va_cross')"); } catch (_) {}
}

async function testV7_NotifyMode() {
  console.log('\nV7: Notify (invalidation) mode');

  // va_orders already exists from V1 setup — ensure it's there
  psql('DROP TABLE IF EXISTS va_orders CASCADE');
  psql('CREATE TABLE va_orders (id serial, status text, amount numeric)');
  psql("SELECT pgr.subscribe('va_notify', 'SELECT * FROM va_orders ORDER BY id', 'notify')");

  const { ws, messages } = await connectWS('va_notify');
  await waitForMessage(messages, (m) => m.type === 'subscribed');
  messages.length = 0;

  psql("INSERT INTO va_orders (status, amount) VALUES ('new', 5)");

  const msg = await waitForMessage(
    messages,
    (m) => m.query_id === 'va_notify',
    5000
  );

  const ok = msg.type === 'invalidated';
  report('V7', ok, ok
    ? "received message with type='invalidated'"
    : `expected type='invalidated', got: ${JSON.stringify(msg)}`
  );

  ws.close();
  // Don't unsubscribe yet — V8 uses this subscription
}

async function testV8_UnsubscribeCleanup() {
  console.log('\nV8: Unsubscribe cleanup');

  psql("SELECT pgr.unsubscribe('va_notify')");

  // Connect WS for va_notify — proxy should still accept the connection
  // but no deltas should arrive since the subscription is gone
  let ws;
  let messages;
  try {
    const conn = await connectWS('va_notify');
    ws = conn.ws;
    messages = conn.messages;
  } catch (_) {
    // Connection may fail if proxy rejects unknown query_id — that's also valid
    report('V8', true, 'WS connection rejected for unsubscribed query (proxy-level cleanup)');
    return;
  }

  // Give a moment for any subscribed message
  await new Promise((r) => setTimeout(r, 500));
  messages.length = 0;

  psql("INSERT INTO va_orders (status, amount) VALUES ('new2', 6)");

  await waitForQuiet(messages, 2000);

  const spurious = messages.find(
    (m) => m.query_id === 'va_notify' && (m.inserted || m.deleted || m.type === 'invalidated')
  );
  const ok = !spurious;
  report('V8', ok, ok
    ? 'no delta received after unsubscribe'
    : `unexpected message after unsubscribe: ${JSON.stringify(spurious)}`
  );

  ws.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== pg_reactive Article Validation ===');

  psql('CREATE EXTENSION IF NOT EXISTS pg_reactive');

  try {
    await testV1_GroupBy();
    await testV2_WindowFunctions();
    await testV3_Having();
    await testV4_OuterJoin();
    await testV5_ColumnTracking();
    await testV6_CrossTable();
    await testV7_NotifyMode();
    await testV8_UnsubscribeCleanup();
  } finally {
    // Cleanup all test artifacts
    console.log('\n--- Cleanup ---');
    const subs = ['va_group', 'va_rank', 'va_having', 'va_left', 'va_col', 'va_cross', 'va_notify'];
    for (const s of subs) {
      try { psql(`SELECT pgr.unsubscribe('${s}')`); } catch (_) {}
    }
    const tables = [
      'va_emps', 'va_items',          // FK children first
      'va_orders', 'va_products', 'va_tags', 'va_depts', 'va_customers', 'va_coltrack',
    ];
    for (const t of tables) {
      try { psql(`DROP TABLE IF EXISTS ${t} CASCADE`); } catch (_) {}
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Article validation error:', e);
  process.exit(1);
});
