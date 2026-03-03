/**
 * E2E test: PG INSERT -> pg_reactive trigger -> NOTIFY -> Rust proxy -> WebSocket client
 *
 * Prerequisites:
 * - DB running with pg_reactive loaded and e2e_q1 subscribed
 * - Proxy running on port 8080
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Auto-install ws if not available (CI may not have it pre-installed)
const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const PROXY_URL = 'ws://127.0.0.1:8080/ws/e2e_q1';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const TIMEOUT_MS = 10000;

function psql(sql) {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'pg_reactive_test', '-t', '-A', '-c', sql],
    { encoding: 'utf-8' }
  ).trim();
}

async function main() {
  console.log('--- E2E WebSocket Test ---');

  // 1. Connect WebSocket
  const ws = new WebSocket(PROXY_URL, { headers: { Authorization: `Bearer ${ANON_KEY}` } });
  const messages = [];

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), TIMEOUT_MS);
    ws.on('open', () => { clearTimeout(timer); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    console.log('  WS message:', JSON.stringify(msg).slice(0, 200));
  });

  await connected;
  console.log('1. WebSocket connected');

  // Wait for subscribed message
  await new Promise(r => setTimeout(r, 500));

  const subMsg = messages.find(m => m.type === 'subscribed');
  if (!subMsg) {
    console.error('FAIL: no subscribed message received');
    process.exit(1);
  }
  console.log('2. Received subscribed confirmation');

  // 2. Do an INSERT to trigger delta
  console.log('3. Inserting row into e2e_test...');
  psql("INSERT INTO e2e_test(name) VALUES ('e2e_alice')");

  // 3. Wait for delta message (flat format: {query_id, inserted, deleted})
  const deltaReceived = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const check = setInterval(() => {
      const delta = messages.find(m => m.query_id === 'e2e_q1' && m.inserted);
      if (delta) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(true);
      }
    }, 100);
  });

  if (!deltaReceived) {
    console.error('FAIL: no delta received within 5s');
    console.log('  Messages received:', JSON.stringify(messages, null, 2));
    ws.close();
    process.exit(1);
  }

  const deltaMsg = messages.find(m => m.query_id === 'e2e_q1' && m.inserted);
  console.log('4. Delta received:', JSON.stringify(deltaMsg));

  // Verify the delta contains the inserted row
  const inserted = deltaMsg.inserted || [];
  const hasAlice = inserted.some(r => r.name === 'e2e_alice');
  if (!hasAlice) {
    console.error('FAIL: delta does not contain inserted row');
    ws.close();
    process.exit(1);
  }
  console.log('5. Delta contains expected row');

  // 4. Test DELETE
  console.log('6. Deleting row...');
  messages.length = 0;
  psql("DELETE FROM e2e_test WHERE name = 'e2e_alice'");

  const deleteReceived = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const check = setInterval(() => {
      const delta = messages.find(m => m.query_id === 'e2e_q1' && m.deleted?.length > 0);
      if (delta) {
        clearTimeout(timer);
        clearInterval(check);
        resolve(true);
      }
    }, 100);
  });

  if (!deleteReceived) {
    console.error('FAIL: no delete delta received within 5s');
    ws.close();
    process.exit(1);
  }

  const deleteMsg = messages.find(m => m.deleted?.length > 0);
  const deletedAlice = deleteMsg.deleted.some(r => r.name === 'e2e_alice');
  if (!deletedAlice) {
    console.error('FAIL: delete delta missing expected row');
    ws.close();
    process.exit(1);
  }
  console.log('7. Delete delta correct');

  ws.close();
  console.log('\n--- ALL E2E TESTS PASSED ---');
  process.exit(0);
}

main().catch(e => {
  console.error('E2E test error:', e);
  process.exit(1);
});
