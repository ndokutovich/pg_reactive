/**
 * E2E test: JWT authentication on WebSocket proxy.
 *
 * Tests:
 * 1. Connection without token is rejected (401)
 * 2. Connection with invalid token is rejected (401)
 * 3. Connection with valid token succeeds
 *
 * Requires: proxy running with JWT_SECRET=test-secret-key
 */
import WebSocket from 'ws';
import http from 'http';
import crypto from 'crypto';

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8080;
const JWT_SECRET = 'test-secret-key';

/**
 * Create a minimal HS256 JWT token.
 */
function createJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };

  function base64url(data) {
    return Buffer.from(data)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Make an HTTP request and return status code.
 */
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: PROXY_HOST, port: PROXY_PORT, path, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } },
      (res) => resolve(res.statusCode)
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function testNoToken() {
  console.log('Test 1: No token -> expect 401');
  const status = await httpGet('/ws/test_q');
  if (status !== 401) {
    console.error(`  FAIL: expected 401, got ${status}`);
    process.exit(1);
  }
  console.log('  PASS: got 401');
}

async function testInvalidToken() {
  console.log('Test 2: Invalid token -> expect 401');
  const status = await httpGet('/ws/test_q?token=invalid.token.here');
  if (status !== 401) {
    console.error(`  FAIL: expected 401, got ${status}`);
    process.exit(1);
  }
  console.log('  PASS: got 401');
}

async function testWrongSecret() {
  console.log('Test 3: Token signed with wrong secret -> expect 401');
  const token = createJwt({ sub: 'user1' }, 'wrong-secret');
  const status = await httpGet(`/ws/test_q?token=${token}`);
  if (status !== 401) {
    console.error(`  FAIL: expected 401, got ${status}`);
    process.exit(1);
  }
  console.log('  PASS: got 401');
}

async function testValidToken() {
  console.log('Test 4: Valid token -> expect WebSocket connection');
  const token = createJwt({ sub: 'user1' }, JWT_SECRET);
  const ws = new WebSocket(`ws://${PROXY_HOST}:${PROXY_PORT}/ws/test_q?token=${token}`);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve('connected');
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      resolve(`rejected:${res.statusCode}`);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  if (result !== 'connected') {
    console.error(`  FAIL: expected connection, got ${result}`);
    process.exit(1);
  }

  // Should receive subscribed message
  const msg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message')), 3000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });

  ws.close();

  if (msg.type !== 'subscribed' || msg.query_id !== 'test_q') {
    console.error(`  FAIL: unexpected message: ${JSON.stringify(msg)}`);
    process.exit(1);
  }
  console.log('  PASS: connected and received subscribed message');
}

async function testHealthNoAuth() {
  console.log('Test 5: Health endpoint requires no auth');
  const status = await new Promise((resolve, reject) => {
    http.get(
      { hostname: PROXY_HOST, port: PROXY_PORT, path: '/health' },
      (res) => resolve(res.statusCode)
    ).on('error', reject);
  });
  if (status !== 200) {
    console.error(`  FAIL: expected 200, got ${status}`);
    process.exit(1);
  }
  console.log('  PASS: got 200');
}

async function main() {
  console.log('--- JWT Auth E2E Test ---\n');

  await testHealthNoAuth();
  await testNoToken();
  await testInvalidToken();
  await testWrongSecret();
  await testValidToken();

  console.log('\n--- JWT AUTH TEST PASSED ---');
  process.exit(0);
}

main().catch(e => {
  console.error('JWT test error:', e);
  process.exit(1);
});
