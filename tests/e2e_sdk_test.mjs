/**
 * E2E test: pgStack SDK (auth + REST query builder + RPC).
 *
 * Tests the SDK against a running pgStack instance.
 * Requires: docker compose running.
 */

// Import SDK source directly (no build step needed for .ts with Node 22+)
// We'll test via HTTP directly to match what the SDK does.

const BASE = 'http://127.0.0.1:8080';
const ANON = process.env.ANON_KEY || 'dev-only-anon-key-do-not-use-in-production';
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

// Simulate what the SDK does internally
class TestClient {
  constructor(url, anonKey) {
    this.url = url;
    this.anonKey = anonKey;
    this.accessToken = null;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.accessToken || this.anonKey}`,
    };
  }

  // Auth methods
  async signUp(email, password, data) {
    const body = { email, password };
    if (data) body.data = data;
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok && json.access_token) {
      this.accessToken = json.access_token;
    }
    return { status: res.status, data: json };
  }

  async signIn(email, password) {
    const body = { email, password, grant_type: 'password' };
    const res = await fetch(`${this.url}/auth/v1/token`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.ok && json.access_token) {
      this.accessToken = json.access_token;
    }
    return { status: res.status, data: json };
  }

  async signOut() {
    const res = await fetch(`${this.url}/auth/v1/logout`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    this.accessToken = null;
    return { status: res.status };
  }

  async getUser() {
    const res = await fetch(`${this.url}/auth/v1/user`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return { status: res.status, data: await res.json() };
  }

  // REST query builder simulation
  from(table) {
    const self = this;
    return {
      _table: table,
      _params: [],
      _method: 'GET',
      _body: null,
      _single: false,
      _select: null,

      select(cols) {
        this._select = cols;
        return this;
      },

      eq(col, val) {
        this._params.push(`${col}=eq.${val}`);
        return this;
      },

      gt(col, val) {
        this._params.push(`${col}=gt.${val}`);
        return this;
      },

      order(col, opts = {}) {
        const dir = opts.ascending === false ? 'desc' : 'asc';
        this._params.push(`order=${col}.${dir}`);
        return this;
      },

      limit(n) {
        this._params.push(`limit=${n}`);
        return this;
      },

      single() {
        this._single = true;
        this._params.push('limit=1');
        return this;
      },

      async insert(values) {
        const qs = this._params.length ? '?' + this._params.join('&') : '';
        const res = await fetch(`${self.url}/rest/v1/${this._table}${qs}`, {
          method: 'POST',
          headers: self.getHeaders(),
          body: JSON.stringify(values),
        });
        const data = await res.json();
        return { status: res.status, data, error: res.ok ? null : data };
      },

      async update(values) {
        const qs = this._params.length ? '?' + this._params.join('&') : '';
        const res = await fetch(`${self.url}/rest/v1/${this._table}${qs}`, {
          method: 'PATCH',
          headers: self.getHeaders(),
          body: JSON.stringify(values),
        });
        const data = await res.json();
        return { status: res.status, data, error: res.ok ? null : data };
      },

      async delete() {
        const qs = this._params.length ? '?' + this._params.join('&') : '';
        const res = await fetch(`${self.url}/rest/v1/${this._table}${qs}`, {
          method: 'DELETE',
          headers: self.getHeaders(),
        });
        const data = await res.json();
        return { status: res.status, data, error: res.ok ? null : data };
      },

      async then(resolve, reject) {
        try {
          const params = [...this._params];
          if (this._select) params.unshift(`select=${encodeURIComponent(this._select)}`);
          const qs = params.length ? '?' + params.join('&') : '';
          const res = await fetch(`${self.url}/rest/v1/${this._table}${qs}`, {
            method: 'GET',
            headers: self.getHeaders(),
          });
          const data = await res.json();
          const result = {
            data: this._single && Array.isArray(data) ? data[0] || null : data,
            error: res.ok ? null : { message: data.error, status: res.status },
            status: res.status,
          };
          resolve(result);
        } catch (e) {
          reject ? reject(e) : resolve({ data: null, error: { message: e.message }, status: 0 });
        }
      }
    };
  }

  // RPC
  async rpc(fn, params = {}) {
    const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(params),
    });
    const data = await res.json();
    return { data: res.ok ? data : null, error: res.ok ? null : data, status: res.status };
  }
}

// ---- Setup ----

async function setup(client) {
  // Clean test data
  const srv = new TestClient(BASE, SRV);
  await fetch(`${BASE}/rest/v1/todos?id=gt.0`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SRV}` },
  });
}

// ---- Tests ----

async function testAuthFlow() {
  console.log('\nSDK Auth Flow');
  const client = new TestClient(BASE, ANON);
  const email = `sdk-test-${Date.now()}@test.com`;
  const password = 'TestPass123!';

  // Sign up
  const signup = await client.signUp(email, password, { display_name: 'SDK User' });
  assert(signup.status === 200 || signup.status === 201, `signup status 200/201 (got ${signup.status})`);
  assert(signup.data.access_token, 'got access token');
  assert(signup.data.user.email === email, 'user email matches');

  // Get user
  const user = await client.getUser();
  assert(user.status === 200, `getUser status 200 (got ${user.status})`);
  assert(user.data.email === email, 'user email correct');

  // Sign out
  const signout = await client.signOut();
  assert(signout.status === 200 || signout.status === 204, `signout ok (got ${signout.status})`);

  // Sign in
  const signin = await client.signIn(email, password);
  assert(signin.status === 200, `signin status 200 (got ${signin.status})`);
  assert(signin.data.access_token, 'got access token on signin');

  return client;
}

async function testQueryBuilder() {
  console.log('\nSDK Query Builder');
  const client = new TestClient(BASE, SRV);

  // Insert
  const ins = await client.from('todos').insert([
    { title: 'SDK todo 1', done: false },
    { title: 'SDK todo 2', done: true },
    { title: 'SDK todo 3', done: false },
  ]);
  assert(ins.status === 201, `insert status 201 (got ${ins.status})`);
  assert(Array.isArray(ins.data) && ins.data.length === 3, '3 rows inserted');

  // Select all
  const all = await client.from('todos').select('*');
  assert(all.status === 200, `select all status 200`);
  assert(all.data.length >= 3, `at least 3 rows (got ${all.data.length})`);

  // Select with filter
  const filtered = await client.from('todos').select('*').eq('done', 'false');
  assert(filtered.data.length >= 2, `filtered rows >= 2 (got ${filtered.data.length})`);

  // Select with order + limit
  const ordered = await client.from('todos').select('id,title')
    .order('id', { ascending: false }).limit(2);
  assert(ordered.data.length === 2, `limited to 2 rows (got ${ordered.data.length})`);
  assert(ordered.data[0].id > ordered.data[1].id, 'ordered descending');

  // Single row
  const single = await client.from('todos').select('*').eq('title', 'SDK todo 1').single();
  assert(single.data !== null, 'single row found');
  assert(!Array.isArray(single.data), 'single returns object, not array');
  assert(single.data.title === 'SDK todo 1', 'correct title');

  // Update
  const firstId = ins.data[0].id;
  const upd = await client.from('todos').eq('id', firstId).update({ done: true });
  assert(upd.status === 200, `update status 200 (got ${upd.status})`);
  assert(upd.data[0].done === true, 'updated done to true');

  // Delete
  const del = await client.from('todos').eq('id', firstId).delete();
  assert(del.status === 200, `delete status 200 (got ${del.status})`);

  // Verify deletion
  const after = await client.from('todos').select('*').eq('id', firstId);
  assert(after.data.length === 0, 'deleted row gone');
}

async function testEmbedding() {
  console.log('\nSDK Embedding');
  const client = new TestClient(BASE, SRV);

  // Authors with posts
  const result = await client.from('authors').select('name,posts(title,published)');
  assert(result.status === 200, `embed status 200 (got ${result.status})`);
  assert(result.data.length >= 1, 'has authors');

  // Each author should have a posts array
  const hasEmbeds = result.data.every(a => Array.isArray(a.posts));
  assert(hasEmbeds, 'all authors have posts array');
}

async function testRpc() {
  console.log('\nSDK RPC');
  const client = new TestClient(BASE, SRV);

  // Scalar function
  const sum = await client.rpc('add_numbers', { a: 5, b: 3 });
  assert(sum.data === 8, `5 + 3 = 8 (got ${sum.data})`);

  // Text function
  const greeting = await client.rpc('get_greeting', { name: 'SDK' });
  assert(greeting.data === 'Hello, SDK!', `greeting (got ${greeting.data})`);

  // Set-returning function
  const authors = await client.rpc('list_active_authors', {});
  assert(Array.isArray(authors.data), 'returns array');
  assert(authors.data.length >= 1, `has authors (got ${authors.data.length})`);
}

// ---- Main ----

async function main() {
  console.log('=== pgStack SDK E2E Test ===');

  await setup();
  await testAuthFlow();
  await testQueryBuilder();
  await testEmbedding();
  await testRpc();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('SDK test error:', e);
  process.exit(1);
});
