/**
 * E2E: presence + client-broadcast are DELIVERED, generation-gated
 * (SECURITY.md inv 17(a)(f), round 39 batch-2 F2).
 *
 * Mirrors Go realtime.TestPresenceJoin_BroadcastsJoinEvent /
 * TestPresenceUpdate_BroadcastsStateEvent and the broadcast envelope shape from
 * dispatchClientMessage. Uses an ad-hoc `_presence_` channel (public, generation
 * 0, no catalog row) so two peers share a generation and must see each other's
 * presence_join / presence_state / broadcast events.
 *
 * Before the Rust presence port these events were never emitted (the WS receive
 * loop dropped all inbound client text). This proves delivery now works on Rust.
 *
 * Requires: a proxy reachable at WS_BASE (default ws://127.0.0.1:8080).
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const _testDir = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(_testDir, 'node_modules', 'ws'))) {
  execFileSync('npm', ['install'], { cwd: _testDir, stdio: 'inherit' });
}
const { default: WebSocket } = await import('ws');

const URL = process.env.WS_BASE || 'ws://127.0.0.1:8080';
const ANON_KEY = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(qid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}/ws/${qid}?apikey=${ANON_KEY}`);
    const messages = [];
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('error', () => {});
    const t = setTimeout(() => reject(new Error(`no 'subscribed' for ${qid}`)), 4000);
    ws.on('message', (d) => {
      if (d.toString().includes('"subscribed"')) {
        clearTimeout(t);
        resolve({ ws, messages });
      }
    });
  });
}

let failures = 0;
const check = (c, m) => { if (c) console.log(`  ✓ ${m}`); else { console.error(`  ✗ ${m}`); failures++; } };

const channel = '_presence_delivery_probe';
console.log('=== presence/broadcast are delivered to same-generation peers ===');

const peer1 = await connect(channel);
await sleep(150);
const peer2 = await connect(channel); // peer2 joining should reach peer1
await sleep(400);

const sawJoin = peer1.messages.some((m) => {
  try { const o = JSON.parse(m); return o.type === 'presence_join' && o.channel === channel; }
  catch { return false; }
});
check(sawJoin, 'peer1 observed a presence_join when peer2 connected (presence DELIVERED)');

// peer2 sends a presence state update; peer1 must receive presence_state.
peer2.ws.send(JSON.stringify({ type: 'presence', state: { status: 'online' } }));
await sleep(400);
const sawState = peer1.messages.some((m) => {
  try { const o = JSON.parse(m); return o.type === 'presence_state' && /online/.test(m); }
  catch { return false; }
});
check(sawState, 'peer1 observed peer2 presence_state update');

// peer2 broadcasts; peer1 must receive the server-wrapped envelope (with `from`).
peer2.ws.send(JSON.stringify({ type: 'broadcast', payload: { hello: 'world' } }));
await sleep(400);
const sawBroadcast = peer1.messages.some((m) => {
  try { const o = JSON.parse(m); return o.type === 'broadcast' && o.from && o.payload && o.payload.hello === 'world'; }
  catch { return false; }
});
check(sawBroadcast, 'peer1 received peer2 client broadcast wrapped as {type:broadcast,from,payload}');

// peer2 leaves; peer1 must observe a presence_leave.
peer2.ws.close();
await sleep(500);
const sawLeave = peer1.messages.some((m) => {
  try { const o = JSON.parse(m); return o.type === 'presence_leave' && o.channel === channel; }
  catch { return false; }
});
check(sawLeave, 'peer1 observed a presence_leave when peer2 disconnected');

try { peer1.ws.close(); } catch {}

if (failures > 0) { console.error(`\nFAIL: ${failures} — presence/broadcast not delivered.`); process.exit(1); }
console.log('\nPASS: presence join/state/leave and client broadcast are delivered to same-generation peers.');
