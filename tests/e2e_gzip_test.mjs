/**
 * E2E test: Gzip compression.
 *
 * Verifies the proxy returns gzip-compressed responses when the client
 * sends Accept-Encoding: gzip. Requires docker compose running.
 */

import { createGunzip } from 'node:zlib';
import { Buffer } from 'node:buffer';

const BASE = 'http://127.0.0.1:8080';
const SRV = process.env.SERVICE_ROLE_KEY || 'dev-only-service-role-key-do-not-use-in-production';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  PASS: ${msg}`);
  passed++;
  return true;
}

/**
 * Fetch with raw response (no automatic decompression).
 * Node's fetch auto-decompresses by default, so we use http.request directly.
 */
async function rawFetch(path, acceptEncoding) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SRV,
        'Authorization': `Bearer ${SRV}`,
      },
    };
    if (acceptEncoding) {
      opts.headers['Accept-Encoding'] = acceptEncoding;
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Decompress a gzip buffer. */
function gunzip(buf) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createGunzip();
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end(buf);
  });
}

// ---- Setup ----

async function setup() {
  // Ensure test data exists so REST responses have enough body for gzip.
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SRV,
    'Authorization': `Bearer ${SRV}`,
  };
  await fetch(`${BASE}/rest/v1/todos?id=gt.0`, { method: 'DELETE', headers });
  const rows = Array.from({ length: 20 }, (_, i) => ({
    title: `Gzip test item ${i}`,
    done: false,
  }));
  await fetch(`${BASE}/rest/v1/todos`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rows),
  });
}

// ---- Tests ----

async function testGzipCompressed() {
  console.log('Test: gzip compressed response');
  const res = await rawFetch('/rest/v1/todos?select=*', 'gzip');

  assert(res.status === 200, `status is 200 (got ${res.status})`);
  assert(
    res.headers['content-encoding'] === 'gzip',
    `Content-Encoding is gzip (got ${res.headers['content-encoding']})`
  );

  // Verify we can decompress and parse the JSON.
  const decompressed = await gunzip(res.body);
  const json = JSON.parse(decompressed.toString());
  assert(Array.isArray(json), 'decompressed body is valid JSON array');
  assert(json.length >= 20, `response has >= 20 rows (got ${json.length})`);
}

async function testNoGzipWithoutHeader() {
  console.log('Test: no gzip without Accept-Encoding');
  const res = await rawFetch('/rest/v1/todos?select=*', null);

  assert(res.status === 200, `status is 200 (got ${res.status})`);
  assert(
    res.headers['content-encoding'] !== 'gzip',
    `Content-Encoding is not gzip (got ${res.headers['content-encoding'] || 'none'})`
  );

  // Body should be plain JSON.
  const json = JSON.parse(res.body.toString());
  assert(Array.isArray(json), 'body is valid JSON array without gzip');
}

async function testGzipOnHealthEndpoint() {
  console.log('Test: gzip on /health');
  const res = await rawFetch('/health', 'gzip');
  assert(res.status === 200, `health status is 200 (got ${res.status})`);
  // Health response is small — chi may skip compression for tiny bodies.
  // We just verify it doesn't error.
  if (res.headers['content-encoding'] === 'gzip') {
    const decompressed = await gunzip(res.body);
    assert(decompressed.length > 0, 'gzip health response decompresses');
  } else {
    const json = JSON.parse(res.body.toString());
    assert(json.status !== undefined, 'health response is valid JSON');
  }
}

// ---- Main ----

async function main() {
  console.log('=== E2E Gzip Tests ===\n');
  await setup();
  await testGzipCompressed();
  await testNoGzipWithoutHeader();
  await testGzipOnHealthEndpoint();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
