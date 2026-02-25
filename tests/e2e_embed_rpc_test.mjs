/**
 * E2E test: Resource Embedding (A5) and RPC (A6).
 *
 * Requires: docker compose running with test tables (authors, posts, comments)
 * and test functions (add_numbers, get_greeting, list_active_authors, get_post_stats).
 */

const BASE = 'http://127.0.0.1:8080';
const SRV = 'srv-key-99999';

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

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// ---- Setup ----

async function setup() {
  // Clean existing data
  await api('DELETE', '/rest/v1/comments?id=gt.0', null, SRV);
  await api('DELETE', '/rest/v1/posts?id=gt.0', null, SRV);
  await api('DELETE', '/rest/v1/authors?id=gt.0', null, SRV);

  // Insert authors
  const authorsRes = await api('POST', '/rest/v1/authors', [
    { name: 'Alice', bio: 'Writes about Rust' },
    { name: 'Bob', bio: 'Writes about TypeScript' },
  ], SRV);

  const authors = authorsRes.json;
  const aliceId = authors[0].id;
  const bobId = authors[1].id;

  // Insert posts
  const postsRes = await api('POST', '/rest/v1/posts', [
    { author_id: aliceId, title: 'Intro to Rust', body: 'Rust is great', published: true },
    { author_id: aliceId, title: 'Advanced Rust', body: 'Lifetimes explained', published: false },
    { author_id: bobId, title: 'TypeScript Tips', body: 'TS is typed JS', published: true },
  ], SRV);

  const posts = postsRes.json;

  // Insert comments
  await api('POST', '/rest/v1/comments', [
    { post_id: posts[0].id, author_id: bobId, content: 'Great intro!' },
    { post_id: posts[0].id, author_id: aliceId, content: 'Thanks Bob!' },
    { post_id: posts[2].id, author_id: aliceId, content: 'Nice tips' },
  ], SRV);

  return { aliceId, bobId, posts };
}

// ---- Embedding Tests ----

async function testEmbedOneToMany() {
  console.log('\nTest E1: Embed one-to-many (authors → posts)');
  const r = await api('GET', '/rest/v1/authors?select=*,posts(id,title)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array');
  assert(r.json.length === 2, `2 authors (got ${r.json.length})`);

  const alice = r.json.find(a => a.name === 'Alice');
  assert(alice !== undefined, 'found Alice');
  assert(Array.isArray(alice.posts), 'Alice has posts array');
  assert(alice.posts.length === 2, `Alice has 2 posts (got ${alice.posts.length})`);
  assert(alice.posts[0].id !== undefined, 'post has id');
  assert(alice.posts[0].title !== undefined, 'post has title');
  // Ensure only selected columns
  assert(alice.posts[0].body === undefined, 'post has no body (column selection)');

  const bob = r.json.find(a => a.name === 'Bob');
  assert(bob.posts.length === 1, `Bob has 1 post (got ${bob.posts.length})`);
}

async function testEmbedManyToOne() {
  console.log('\nTest E2: Embed many-to-one (posts → authors)');
  const r = await api('GET', '/rest/v1/posts?select=id,title,authors(name)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 3, `3 posts (got ${r.json.length})`);

  const post = r.json[0];
  assert(post.authors !== undefined, 'post has embedded authors');
  // Many-to-one returns single object
  assert(typeof post.authors === 'object' && !Array.isArray(post.authors),
    'authors is an object (many-to-one)');
  assert(post.authors.name !== undefined, 'embedded author has name');
}

async function testEmbedDeep() {
  console.log('\nTest E3: Embed one-to-many (posts → comments)');
  const r = await api('GET', '/rest/v1/posts?select=title,comments(content)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);

  const introPost = r.json.find(p => p.title === 'Intro to Rust');
  assert(introPost !== undefined, 'found Intro post');
  assert(Array.isArray(introPost.comments), 'has comments array');
  assert(introPost.comments.length === 2, `Intro post has 2 comments (got ${introPost.comments.length})`);

  const advancedPost = r.json.find(p => p.title === 'Advanced Rust');
  assert(advancedPost.comments.length === 0, 'Advanced post has 0 comments');
}

async function testEmbedWithFilter() {
  console.log('\nTest E4: Embed with parent filter');
  const r = await api('GET', '/rest/v1/posts?select=title,comments(content)&published=eq.true', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 2, `2 published posts (got ${r.json.length})`);
}

async function testEmbedBadRelation() {
  console.log('\nTest E5: Embed with non-existent relation');
  const r = await api('GET', '/rest/v1/authors?select=*,nonexistent(id)', null, SRV);
  assert(r.status === 400 || r.status === 404, `bad relation -> 400/404 (got ${r.status})`);
}

async function testEmbedNoFK() {
  console.log('\nTest E6: Embed with no FK relationship');
  const r = await api('GET', '/rest/v1/authors?select=*,todos(id)', null, SRV);
  assert(r.status === 400, `no FK -> 400 (got ${r.status})`);
}

// ---- RPC Tests ----

async function testRpcScalar() {
  console.log('\nTest R1: RPC scalar function (add_numbers)');
  const r = await api('POST', '/rest/v1/rpc/add_numbers', { a: 3, b: 7 }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 10, `3 + 7 = 10 (got ${r.json})`);
}

async function testRpcText() {
  console.log('\nTest R2: RPC text function (get_greeting)');
  const r = await api('POST', '/rest/v1/rpc/get_greeting', { name: 'World' }, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 'Hello, World!', `greeting (got ${r.json})`);
}

async function testRpcSetReturning() {
  console.log('\nTest R3: RPC set-returning function (list_active_authors)');
  const r = await api('POST', '/rest/v1/rpc/list_active_authors', {}, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array');
  assert(r.json.length === 2, `2 authors (got ${r.json.length})`);
  assert(r.json[0].name !== undefined, 'has name field');
}

async function testRpcTableReturn() {
  console.log('\nTest R4: RPC table-returning function (get_post_stats)');
  const r = await api('POST', '/rest/v1/rpc/get_post_stats', {}, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  // Should return stats object
  if (Array.isArray(r.json)) {
    // Might return array with one element
    assert(r.json.length === 1, 'single stats row');
    assert(r.json[0].total_posts === 3, `3 total posts (got ${r.json[0].total_posts})`);
    assert(r.json[0].published_posts === 2, `2 published (got ${r.json[0].published_posts})`);
  } else {
    assert(r.json.total_posts === 3, `3 total posts (got ${r.json.total_posts})`);
    assert(r.json.published_posts === 2, `2 published (got ${r.json.published_posts})`);
  }
}

async function testRpcGet() {
  console.log('\nTest R5: RPC via GET with query params');
  const r = await api('GET', '/rest/v1/rpc/add_numbers?a=10&b=20', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json === 30, `10 + 20 = 30 (got ${r.json})`);
}

async function testRpcNotFound() {
  console.log('\nTest R6: RPC non-existent function');
  const r = await api('POST', '/rest/v1/rpc/nonexistent_func', {}, SRV);
  assert(r.status === 400 || r.status === 404, `not found -> error (got ${r.status})`);
}

async function testRpcBadName() {
  console.log('\nTest R7: RPC invalid function name');
  const r = await api('POST', '/rest/v1/rpc/drop table users', {}, SRV);
  assert(r.status === 400, `bad name -> 400 (got ${r.status})`);
}

// ---- Main ----

async function main() {
  console.log('=== Resource Embedding & RPC E2E Test ===');

  await setup();

  // Embedding tests
  await testEmbedOneToMany();
  await testEmbedManyToOne();
  await testEmbedDeep();
  await testEmbedWithFilter();
  await testEmbedBadRelation();
  await testEmbedNoFK();

  // RPC tests
  await testRpcScalar();
  await testRpcText();
  await testRpcSetReturning();
  await testRpcTableReturn();
  await testRpcGet();
  await testRpcNotFound();
  await testRpcBadName();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
