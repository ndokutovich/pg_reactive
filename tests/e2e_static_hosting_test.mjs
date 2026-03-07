/**
 * E2E test: Static file hosting (PUBLIC_DIR).
 *
 * Verifies the proxy serves static files from PUBLIC_DIR with correct
 * SPA fallback, cache headers, security headers, content types, gzip,
 * and directory traversal protection. Requires docker compose running.
 */

const BASE = 'http://127.0.0.1:8080';

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

// ---- Tests ----

async function testIndexHtmlServed() {
  console.log('Test: index.html served at root');
  const res = await fetch(`${BASE}/`);
  assert(res.status === 200, `status is 200 (got ${res.status})`);

  const ct = res.headers.get('content-type');
  assert(ct && ct.includes('text/html'), `content-type is text/html (got ${ct})`);

  const body = await res.text();
  assert(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'body contains HTML');
}

async function testCssAssetServed() {
  console.log('Test: CSS asset served');
  const res = await fetch(`${BASE}/style.css`);
  assert(res.status === 200, `status is 200 (got ${res.status})`);

  const ct = res.headers.get('content-type');
  assert(ct && ct.includes('text/css'), `content-type is text/css (got ${ct})`);

  const body = await res.text();
  assert(body.length > 0, 'CSS body is not empty');
}

async function testSvgAssetServed() {
  console.log('Test: SVG asset served');
  const res = await fetch(`${BASE}/icon.svg`);
  assert(res.status === 200, `status is 200 (got ${res.status})`);

  const ct = res.headers.get('content-type');
  assert(ct && ct.includes('svg'), `content-type contains svg (got ${ct})`);
}

async function testSPAFallback() {
  console.log('Test: SPA fallback for client-side routes');
  const res = await fetch(`${BASE}/some/deep/spa/route`);
  assert(res.status === 200, `status is 200 (got ${res.status})`);

  const ct = res.headers.get('content-type');
  assert(ct && ct.includes('text/html'), `falls back to text/html (got ${ct})`);

  const body = await res.text();
  assert(body.includes('<!DOCTYPE html>') || body.includes('<html'), 'SPA fallback returns index.html content');
}

async function testMissingAsset404() {
  console.log('Test: missing asset with extension returns 404');
  const res = await fetch(`${BASE}/does-not-exist.js`);
  assert(res.status === 404, `status is 404 (got ${res.status})`);
}

async function testMissingAssetVariousExtensions() {
  console.log('Test: missing assets with various extensions return 404');
  for (const ext of ['.css', '.png', '.json', '.woff2', '.map']) {
    const res = await fetch(`${BASE}/nonexistent${ext}`);
    assert(res.status === 404, `${ext} returns 404 (got ${res.status})`);
  }
}

async function testCacheControlIndexHtml() {
  console.log('Test: Cache-Control for index.html is no-cache');
  const res = await fetch(`${BASE}/`);
  const cc = res.headers.get('cache-control');
  assert(cc === 'no-cache', `cache-control is no-cache (got ${cc})`);
}

async function testCacheControlStaticAsset() {
  console.log('Test: Cache-Control for non-hashed static asset is max-age=3600');
  const res = await fetch(`${BASE}/style.css`);
  const cc = res.headers.get('cache-control');
  assert(cc && cc.includes('max-age=3600'), `cache-control includes max-age=3600 (got ${cc})`);
}

async function testSecurityHeaders() {
  console.log('Test: security headers present on static files');
  const res = await fetch(`${BASE}/`);

  const xcto = res.headers.get('x-content-type-options');
  assert(xcto === 'nosniff', `X-Content-Type-Options is nosniff (got ${xcto})`);

  const xfo = res.headers.get('x-frame-options');
  assert(xfo === 'SAMEORIGIN', `X-Frame-Options is SAMEORIGIN (got ${xfo})`);

  const rp = res.headers.get('referrer-policy');
  assert(rp === 'strict-origin-when-cross-origin', `Referrer-Policy set (got ${rp})`);

  const csp = res.headers.get('content-security-policy');
  assert(csp && csp.includes("default-src 'self'"), `CSP includes default-src 'self' (got ${csp})`);
  assert(csp && csp.includes("script-src"), 'CSP includes script-src directive');
  assert(csp && csp.includes("connect-src") && csp.includes("ws:"), 'CSP allows WebSocket connections');
}

async function testDirectoryTraversal() {
  console.log('Test: directory traversal is blocked');
  const paths = [
    '/../docker-compose.yml',
    '/..%2Fdocker-compose.yml',
    '/%2e%2e/docker-compose.yml',
  ];
  for (const p of paths) {
    const res = await fetch(`${BASE}${p}`);
    // Should NOT return the file content — either 404 or redirect to /
    assert(
      res.status === 404 || res.status === 301 || res.status === 200,
      `traversal attempt ${p} does not leak files (status ${res.status})`
    );
    if (res.status === 200) {
      const body = await res.text();
      assert(
        !body.includes('services:') && !body.includes('docker-compose'),
        `traversal ${p} did not leak docker-compose.yml content`
      );
    }
  }
}

async function testGzipOnStaticFiles() {
  console.log('Test: gzip compression on static files');
  // Use raw http to control Accept-Encoding
  const { default: http } = await import('node:http');
  const { createGunzip } = await import('node:zlib');
  const { Buffer } = await import('node:buffer');

  const res = await new Promise((resolve, reject) => {
    const url = new URL('/', BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/',
      method: 'GET',
      headers: { 'Accept-Encoding': 'gzip' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });

  assert(res.status === 200, `status is 200 (got ${res.status})`);

  if (res.headers['content-encoding'] === 'gzip') {
    assert(true, 'Content-Encoding is gzip for index.html');
    // Verify decompression works
    const decompressed = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = createGunzip();
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      stream.end(res.body);
    });
    assert(decompressed.toString().includes('<html'), 'gzip-compressed body decompresses to valid HTML');
  } else {
    console.log('  SKIP: gzip not enabled on static files (GZIP_LEVEL=0 or body too small)');
  }
}

async function testCORSHeaders() {
  console.log('Test: CORS headers present on static files');
  const res = await fetch(`${BASE}/`);
  const acao = res.headers.get('access-control-allow-origin');
  assert(acao !== null, `Access-Control-Allow-Origin is set (got ${acao})`);
}

async function testOnlyGetAndHead() {
  console.log('Test: only GET/HEAD methods allowed for static files');
  // POST to a static path should not serve the file
  const res = await fetch(`${BASE}/style.css`, { method: 'POST' });
  // PublicSPA returns 404 for non-GET/HEAD
  assert(res.status === 404 || res.status === 405, `POST to static file returns 404 or 405 (got ${res.status})`);
}

// ---- Main ----

async function main() {
  console.log('=== E2E Static Hosting Tests ===\n');

  await testIndexHtmlServed();
  await testCssAssetServed();
  await testSvgAssetServed();
  await testSPAFallback();
  await testMissingAsset404();
  await testMissingAssetVariousExtensions();
  await testCacheControlIndexHtml();
  await testCacheControlStaticAsset();
  await testSecurityHeaders();
  await testDirectoryTraversal();
  await testGzipOnStaticFiles();
  await testCORSHeaders();
  await testOnlyGetAndHead();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
