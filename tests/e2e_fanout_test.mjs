/**
 * E2E test: Multi-client fan-out — multiple WebSocket clients receive the same delta.
 */
import WebSocket from 'ws';
import { execFileSync } from 'child_process';

const PROXY_URL = 'ws://127.0.0.1:8080/ws/fanout_q';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const NUM_CLIENTS = 3;

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

async function connectClient(id) {
  const ws = new WebSocket(PROXY_URL, { headers: { Authorization: `Bearer ${ANON_KEY}` } });
  const messages = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Client ${id}: connect timeout`)), 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  // Wait for subscribed message
  await new Promise(r => setTimeout(r, 300));

  return { ws, messages, id };
}

async function main() {
  console.log(`--- E2E Fan-out Test (${NUM_CLIENTS} clients) ---`);

  // Setup
  psql("CREATE EXTENSION IF NOT EXISTS pg_reactive");
  psql("DROP TABLE IF EXISTS fanout_test CASCADE");
  psql("CREATE TABLE fanout_test(id serial PRIMARY KEY, val text)");
  psql("SELECT pgr.subscribe('fanout_q', 'SELECT id, val FROM fanout_test')");

  // Connect N clients
  const clients = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    clients.push(await connectClient(i));
  }
  console.log(`1. ${NUM_CLIENTS} WebSocket clients connected`);

  // Verify all got subscribed message
  for (const c of clients) {
    const sub = c.messages.find(m => m.type === 'subscribed');
    if (!sub) {
      console.error(`FAIL: client ${c.id} didn't receive subscribed message`);
      process.exit(1);
    }
  }
  console.log('2. All clients received subscribed confirmation');

  // Clear messages
  for (const c of clients) c.messages.length = 0;

  // Trigger a delta
  console.log('3. Inserting row...');
  psql("INSERT INTO fanout_test(val) VALUES ('broadcast')");

  // Wait for deltas
  await new Promise(r => setTimeout(r, 2000));

  // Verify all clients got the delta
  let allGood = true;
  for (const c of clients) {
    const delta = c.messages.find(m => m.query_id === 'fanout_q' && m.inserted);
    if (!delta) {
      console.error(`FAIL: client ${c.id} did not receive delta`);
      allGood = false;
    } else {
      const hasBroadcast = delta.inserted.some(r => r.val === 'broadcast');
      if (!hasBroadcast) {
        console.error(`FAIL: client ${c.id} delta missing 'broadcast' row`);
        allGood = false;
      }
    }
  }

  if (!allGood) {
    clients.forEach(c => c.ws.close());
    process.exit(1);
  }
  console.log(`4. All ${NUM_CLIENTS} clients received identical delta`);

  // Cleanup
  clients.forEach(c => c.ws.close());
  psql("SELECT pgr.unsubscribe('fanout_q')");
  psql("DROP TABLE fanout_test");

  console.log('\n--- FAN-OUT TEST PASSED ---');
  process.exit(0);
}

main().catch(e => {
  console.error('Fan-out test error:', e);
  process.exit(1);
});
