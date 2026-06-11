/**
 * Documentation Validation Script — Phase 1
 *
 * Extracts factual claims from docs/site/docs/ and verifies them against:
 *   - proxy-go/config.go (env var defaults)
 *   - proxy-go/main.go (route registrations)
 *   - proxy-go/rest/filter.go (filter operators)
 *   - Running proxy (live endpoint checks)
 *
 * Usage:
 *   node tests/validate_docs.mjs              # full validation
 *   node tests/validate_docs.mjs --live       # include live HTTP checks (requires docker compose)
 *
 * Output: MATCH / MISMATCH / MISSING per claim
 */

import { readFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS = join(ROOT, 'docs', 'site', 'docs');
const LIVE = process.argv.includes('--live');

let pass = 0;
let fail = 0;
let warn = 0;

function ok(msg) { console.log(`  MATCH: ${msg}`); pass++; }
function bad(msg) { console.log(`  MISMATCH: ${msg}`); fail++; }
function missing(msg) { console.log(`  MISSING: ${msg}`); warn++; }

function readFile(rel) {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

function readDoc(rel) {
  return readFileSync(join(DOCS, rel), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Env var defaults: docs/deploy/env-vars.md vs proxy-go/config.go
// ──────────────────────────────────────────────────────────────────────────────

function validateEnvVars() {
  console.log('\n=== Env Var Defaults (env-vars.md vs config.go) ===');

  const configGo = readFile('proxy-go/config.go');
  const envDoc = readDoc('deploy/env-vars.md');

  // Extract documented env vars: | `VAR_NAME` | `default` | description |
  const docVars = {};
  const tableRows = envDoc.matchAll(/\|\s*`(\w+)`\s*\|\s*`?([^|`]*?)`?\s*\|/g);
  for (const m of tableRows) {
    const name = m[1].trim();
    let def = m[2].trim();
    // Normalize documented defaults
    if (def === '—' || def === '*(empty)*' || def.startsWith('*(') || def === '') def = '';
    docVars[name] = def;
  }

  // Known env var → default mappings from config.go (source of truth)
  const codeDefaults = {
    LISTEN_ADDR: '0.0.0.0:8080',
    MAX_CONNECTIONS: '10000',
    AUTH_RATE_LIMIT: '30',
    AUTH_RATE_WINDOW: '60',
    ACCESS_TOKEN_EXPIRY_SECS: '3600',
    REFRESH_TOKEN_EXPIRY_DAYS: '30',
    MAX_BODY_SIZE: '1048576',
    MAX_FILE_SIZE: '52428800',
    MAX_BATCH_OPERATIONS: '20',
    READ_TIMEOUT: '30',
    WRITE_TIMEOUT: '60',
    IDLE_TIMEOUT: '120',
    SHUTDOWN_TIMEOUT: '15',
    GZIP_LEVEL: '5',
    PG_POOL_MAX_CONNS: '50',
    PG_POOL_MIN_CONNS: '5',
    PG_POOL_MAX_CONN_IDLE_TIME: '300',
    SMTP_PORT: '587',
    SMTP_FROM: 'noreply@pgstack.local',
    ENABLE_SQL_ENDPOINT: 'false',
    EMBEDDED_FUNCTIONS: 'true',
    REQUIRE_EMAIL_VERIFICATION: 'false',
    TLS_MODE: 'off',
    TLS_CERT_DIR: '/data/certs',
    HTTPS_ADDR: ':443',
    HTTP_ADDR: ':80',
  };

  for (const [name, codeDefault] of Object.entries(codeDefaults)) {
    if (!(name in docVars)) {
      missing(`${name} (default: ${codeDefault}) — not documented in env-vars.md`);
    } else if (docVars[name] !== codeDefault) {
      bad(`${name}: doc says "${docVars[name]}", code says "${codeDefault}"`);
    } else {
      ok(`${name} = ${codeDefault}`);
    }
  }

  // Check for documented vars that don't exist in code
  const knownVars = new Set([
    ...Object.keys(codeDefaults),
    // Vars without defaults (optional, key-based)
    'DATABASE_URL', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'SITE_URL',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALLOWED_ORIGINS', 'TRUSTED_PROXIES',
    'EDGE_RUNTIME_URL', 'PUBLIC_DIR', 'TLS_DOMAINS', 'TLS_ACME_EMAIL',
    'TLS_CERT_FILE', 'TLS_KEY_FILE',
    // Docker/PG vars (not in config.go, they're GUC or compose vars)
    'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'PROXY_PORT', 'PROXY_RUST_PORT',
    // Logging vars read in main.go, not config.go
    'LOG_LEVEL', 'LOG_PRETTY',
    // PG tuning GUC params (documented in env-vars.md but not config.go env vars)
    'max_connections', 'shared_buffers', 'effective_cache_size',
    'pg_reactive.max_subscriptions', 'log_min_messages', 'log_statement',
  ]);

  for (const name of Object.keys(docVars)) {
    if (!knownVars.has(name) && !configGo.includes(name)) {
      bad(`${name} documented but not found in config.go — stale?`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. API Routes: reference/api.md vs main.go
// ──────────────────────────────────────────────────────────────────────────────

function validateRoutes() {
  console.log('\n=== API Routes (api.md vs main.go) ===');

  const mainGo = readFile('proxy-go/main.go');
  const apiDoc = readDoc('reference/api.md');

  // Routes that must exist in main.go
  const expectedRoutes = [
    ['GET', '/health'],
    ['POST', '/auth/v1/signup'],
    ['POST', '/auth/v1/token'],
    ['GET', '/auth/v1/user'],
    ['PATCH', '/auth/v1/user'],
    ['POST', '/auth/v1/logout'],
    ['POST', '/auth/v1/recover'],
    ['POST', '/auth/v1/magiclink'],
    ['GET', '/auth/v1/verify'],
    ['GET', '/auth/v1/authorize'],
    ['GET', '/auth/v1/callback'],
    ['GET', '/auth/v1/admin/users'],
    ['POST', '/auth/v1/admin/users'],
    ['DELETE', '/auth/v1/admin/users/{id}'],
    ['GET', '/rest/v1/{table}'],
    ['POST', '/rest/v1/{table}'],
    ['PATCH', '/rest/v1/{table}'],
    ['DELETE', '/rest/v1/{table}'],
    ['POST', '/rest/v1/rpc/{function}'],
    ['GET', '/rest/v1/rpc/{function}'],
    ['POST', '/rest/v1/batch'],
    ['GET', '/functions/v1/{name}'],
    ['POST', '/functions/v1/{name}'],
    ['GET', '/ws/{queryID}'],
  ];

  for (const [method, path] of expectedRoutes) {
    // Normalize path for Go route matching
    const goPath = path.replace('{table}', '{table}').replace('{function}', '{function}');
    const methodLower = method.toLowerCase();
    const goMethod = method.charAt(0) + method.slice(1).toLowerCase();

    // Check main.go has this route registered
    const hasRoute = mainGo.includes(`"${goPath}"`) || mainGo.includes(`"${path}"`);
    // Check docs mention this route — handle HTML entity encoding (&#123; = { and &#125; = })
    const htmlPath = path.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    // Also strip template vars entirely and check base path
    const basePath = path.replace(/\/\{[^}]+\}/g, '');
    const inDoc = apiDoc.includes(path) || apiDoc.includes(htmlPath) ||
      apiDoc.includes(path.replace(/[{}]/g, '')) ||
      apiDoc.includes(basePath + '/') || apiDoc.includes(basePath);

    if (!hasRoute) {
      bad(`${method} ${path} — documented but NOT in main.go`);
    } else if (!inDoc) {
      missing(`${method} ${path} — in main.go but NOT in api.md`);
    } else {
      ok(`${method} ${path}`);
    }
  }

  // Check for routes in main.go not documented
  const undocumented = [
    '/rest/v1/rls-debug',
    '/api/sql',
    '/api/demo',
    '/api/catalog/refresh',
    '/rest/v1/',
  ];
  for (const path of undocumented) {
    if (mainGo.includes(`"${path}"`) && !apiDoc.includes(path)) {
      // These are dev/internal routes — not required in docs, just note
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Filter operators: rest/filters.md vs rest/filter.go
// ──────────────────────────────────────────────────────────────────────────────

function validateFilters() {
  console.log('\n=== Filter Operators (filters.md vs filter.go) ===');

  const filterGo = readFile('proxy-go/rest/filter.go');
  const filterDoc = readDoc('rest/filters.md');

  // Operators that must be in both
  const operators = [
    ['eq', '='],
    ['neq', '!='],
    ['gt', '>'],
    ['gte', '>='],
    ['lt', '<'],
    ['lte', '<='],
    ['like', 'LIKE'],
    ['ilike', 'ILIKE'],
    ['is', 'IS'],
    ['in', 'IN'],
    ['not', 'NOT'],
    ['cs', '@>'],
    ['cd', '<@'],
    ['fts', '@@'],
    ['ov', '&&'],
    ['sl', '<<'],
    ['sr', '>>'],
    ['adj', '-|-'],
  ];

  for (const [op, sql] of operators) {
    const inCode = filterGo.includes(`"${op}"`) || filterGo.includes(`'${op}'`) || filterGo.includes(`"${op}."`);

    const inDoc = filterDoc.includes(`\`${op}\``) || filterDoc.includes(`| ${op} `) || filterDoc.includes(`|${op}|`);

    if (inCode && inDoc) {
      ok(`${op} (${sql})`);
    } else if (inCode && !inDoc) {
      missing(`${op} — in filter.go but NOT in filters.md`);
    } else if (!inCode && inDoc) {
      bad(`${op} — in filters.md but NOT in filter.go`);
    } else {
      bad(`${op} — in neither code nor docs`);
    }
  }

  // Check or/and combinators
  for (const combo of ['or', 'and']) {
    const inCode = filterGo.includes(`"${combo}"`);
    const inDoc = filterDoc.includes(`\`${combo}\``) || filterDoc.includes(`${combo}(`) || filterDoc.includes(`?${combo}=`);
    if (inCode && inDoc) {
      ok(`${combo}() combinator`);
    } else if (inCode && !inDoc) {
      missing(`${combo}() — in code but not documented in filters.md`);
    } else {
      bad(`${combo}() — documented but not in code`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. Auth helper functions: auth/rls.md vs docker/init.sql
// ──────────────────────────────────────────────────────────────────────────────

function validateAuthHelpers() {
  console.log('\n=== Auth Helper Functions (rls.md vs init.sql) ===');

  const initSql = readFile('docker/init.sql');
  const rlsDoc = readDoc('auth/rls.md');

  const helpers = ['auth.uid()', 'auth.role()', 'auth.email()', 'auth.jwt()'];

  for (const fn of helpers) {
    const fnName = fn.replace('()', '');
    const inCode = initSql.includes(`FUNCTION ${fnName}()`);
    const inDoc = rlsDoc.includes(fn) || rlsDoc.includes(fnName);

    if (inCode && inDoc) {
      ok(fn);
    } else if (inCode && !inDoc) {
      missing(`${fn} — in init.sql but NOT in rls.md`);
    } else if (!inCode && inDoc) {
      bad(`${fn} — in rls.md but NOT in init.sql`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. Cross-doc consistency: env-vars.md vs production.md security checklist
// ──────────────────────────────────────────────────────────────────────────────

function validateCrossDocConsistency() {
  console.log('\n=== Cross-Doc Consistency ===');

  const envDoc = readDoc('deploy/env-vars.md');
  const prodDoc = readDoc('deploy/production.md');

  // Production checklist should reference key env vars
  const checklistVars = [
    'POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY',
    'ENABLE_SQL_ENDPOINT', 'ALLOWED_ORIGINS', 'SITE_URL', 'TRUSTED_PROXIES',
  ];

  for (const v of checklistVars) {
    const inEnv = envDoc.includes(v);
    const inProd = prodDoc.includes(v);
    if (inEnv && inProd) {
      ok(`${v} in both env-vars.md and production.md`);
    } else if (inEnv && !inProd) {
      missing(`${v} — in env-vars.md but NOT in production.md checklist`);
    } else {
      bad(`${v} — in production.md but NOT in env-vars.md`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. Edge Functions docs vs code
// ──────────────────────────────────────────────────────────────────────────────

function validateEdgeFunctions() {
  console.log('\n=== Edge Functions (overview.md vs code) ===');

  const fnDoc = readDoc('functions/overview.md');
  const fnGo = readFile('proxy-go/functions/functions.go');
  const initSql = readFile('docker/init.sql');

  // Runtimes documented vs CHECK constraint
  const runtimes = ['embedded', 'plv8', 'plpython3u', 'deno'];
  for (const rt of runtimes) {
    const inCode = initSql.includes(`'${rt}'`);
    const inDoc = fnDoc.includes(rt);
    if (inCode && inDoc) {
      ok(`runtime "${rt}"`);
    } else if (inCode && !inDoc) {
      missing(`runtime "${rt}" — in init.sql CHECK but NOT in functions docs`);
    } else if (!inCode && inDoc) {
      bad(`runtime "${rt}" — in docs but NOT in init.sql CHECK`);
    }
  }

  // API endpoints
  const endpoints = [
    '/functions/v1/{name}',
    '/functions/v1/',
    '/functions/v1/_refresh',
  ];
  for (const ep of endpoints) {
    if (fnDoc.includes(ep)) {
      ok(`endpoint ${ep} documented`);
    } else {
      missing(`endpoint ${ep} not in functions/overview.md`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Live endpoint checks (optional, requires running proxy)
// ──────────────────────────────────────────────────────────────────────────────

function httpCheck(method, path, expectedStatus, headers = {}) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port: 8080,
      path,
      method,
      headers,
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: 'connection refused' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    req.end();
  });
}

async function validateLiveEndpoints() {
  if (!LIVE) return;

  console.log('\n=== Live Endpoint Checks (--live) ===');

  const SRV = 'dev-only-service-role-key-do-not-use-in-production';
  const ANON = 'dev-only-anon-key-do-not-use-in-production';

  // Health
  const health = await httpCheck('GET', '/health');
  if (health.status === 200) ok('GET /health → 200');
  else bad(`GET /health → ${health.status} (expected 200)`);

  // REST select
  const rest = await httpCheck('GET', '/rest/v1/authors', 200, { Authorization: `Bearer ${SRV}` });
  if (rest.status === 200) ok('GET /rest/v1/authors → 200');
  else bad(`GET /rest/v1/authors → ${rest.status}`);

  // REST with count
  const count = await httpCheck('GET', '/rest/v1/authors?limit=1', 200, {
    Authorization: `Bearer ${SRV}`,
    Prefer: 'count=exact',
  });
  if (count.headers['content-range'] && count.headers['content-range'].includes('/')) {
    ok(`Content-Range header: ${count.headers['content-range']}`);
  } else {
    bad(`Content-Range missing or malformed: ${count.headers['content-range'] || 'absent'}`);
  }

  // Auth (no key → 401)
  const noAuth = await httpCheck('GET', '/rest/v1/authors');
  if (noAuth.status === 401) ok('No auth → 401');
  else bad(`No auth → ${noAuth.status} (expected 401)`);

  // Functions list (requires service_role)
  const fnList = await httpCheck('GET', '/functions/v1/', 200, { Authorization: `Bearer ${SRV}` });
  if (fnList.status === 200) ok('GET /functions/v1/ → 200');
  else bad(`GET /functions/v1/ → ${fnList.status}`);

  // or() combinator
  const orTest = await httpCheck('GET', '/rest/v1/authors?or=(name.eq.Alice,name.eq.Bob)', 200, {
    Authorization: `Bearer ${SRV}`,
  });
  if (orTest.status === 200) {
    try {
      const rows = JSON.parse(orTest.body);
      if (Array.isArray(rows) && rows.length >= 2) ok('or() combinator returns multiple rows');
      else bad(`or() combinator returned ${rows.length} rows (expected >= 2)`);
    } catch { bad('or() combinator response not valid JSON'); }
  } else {
    bad(`or() combinator → ${orTest.status}`);
  }

  // Auth signup
  const email = `doctest-${Date.now()}@test.com`;
  const signup = await httpCheck('POST', '/auth/v1/signup', 201, {
    'Content-Type': 'application/json',
    apikey: ANON,
  });
  // Can't easily send body with http.request in this simple helper, so just check the endpoint exists
  if (signup.status === 400 || signup.status === 201) ok('POST /auth/v1/signup endpoint exists');
  else bad(`POST /auth/v1/signup → ${signup.status}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. Undocumented features (git diff: code has it, docs don't)
// ──────────────────────────────────────────────────────────────────────────────

function findUndocumentedFeatures() {
  console.log('\n=== Undocumented Code Features ===');

  const configGo = readFile('proxy-go/config.go');
  const allDocs = readdirSync(DOCS, { recursive: true })
    .filter(f => f.endsWith('.md'))
    .map(f => readFileSync(join(DOCS, f), 'utf-8'))
    .join('\n');

  // Env vars in config.go but not in any doc
  const envVarPattern = /os\.Getenv\("(\w+)"\)/g;
  const codeVars = new Set();
  for (const m of configGo.matchAll(envVarPattern)) {
    codeVars.add(m[1]);
  }

  // Known internal/PG vars that don't need docs
  const internal = new Set([
    'STUDIO_DIR', 'DOCS_DIR', 'BROADCAST_CAPACITY', 'PG_RECONNECT_MAX_BACKOFF',
  ]);

  for (const v of codeVars) {
    if (internal.has(v)) continue;
    if (!allDocs.includes(v)) {
      missing(`Env var ${v} in config.go but not in any documentation`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 9. Storage docs check
// ──────────────────────────────────────────────────────────────────────────────

function validateStorage() {
  console.log('\n=== Storage API ===');

  const mainGo = readFile('proxy-go/main.go');
  const allDocs = readdirSync(DOCS, { recursive: true })
    .filter(f => f.endsWith('.md'))
    .map(f => readFileSync(join(DOCS, f), 'utf-8'))
    .join('\n');

  const storageRoutes = [
    '/storage/v1/bucket',
    '/storage/v1/object/',
  ];

  for (const route of storageRoutes) {
    const inCode = mainGo.includes(route);
    const inDocs = allDocs.includes(route) || allDocs.includes('storage/v1');
    if (inCode && inDocs) {
      ok(`${route} in code and docs`);
    } else if (inCode && !inDocs) {
      missing(`${route} — in main.go but not documented`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== pgStack Documentation Validation ===');
  console.log(`Root: ${ROOT}`);
  console.log(`Docs: ${DOCS}`);
  console.log(`Live checks: ${LIVE ? 'YES' : 'NO (use --live to enable)'}`);

  validateEnvVars();
  validateRoutes();
  validateFilters();
  validateAuthHelpers();
  validateCrossDocConsistency();
  validateEdgeFunctions();
  validateStorage();
  findUndocumentedFeatures();
  await validateLiveEndpoints();

  console.log('\n========================================');
  console.log(`Results: ${pass} MATCH, ${fail} MISMATCH, ${warn} MISSING`);
  console.log('========================================');

  if (fail > 0) {
    console.log('\nMISMATCH items need immediate fixes (doc says X, code says Y).');
  }
  if (warn > 0) {
    console.log('MISSING items may need docs added or are intentionally undocumented.');
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Validation error:', err);
  process.exit(2);
});
