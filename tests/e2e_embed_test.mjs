/**
 * E2E test: Resource Embedding (A5).
 *
 * Tests FK-based resource embedding via the `select` parameter:
 *   GET /rest/v1/table?select=*,related_table(col1,col2)
 *
 * Requires: docker compose running with:
 *   JWT_SECRET, SERVICE_ROLE_KEY (reads from env, defaults to docker-compose values)
 *
 * Tables created in setup (via /api/sql):
 *   public.embed_authors  (id serial PK, name text, active bool)
 *   public.embed_posts    (id serial PK, author_id int FK->embed_authors, title text, published bool)
 *   public.embed_comments (id serial PK, post_id int FK->embed_posts, body text)
 *
 * Run with: node tests/e2e_embed_test.mjs
 */

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

async function sql(query) {
  return api('POST', '/api/sql', { sql: query }, SRV);
}

// ---- Setup ----

async function setup() {
  console.log('Setting up embed test tables...');

  // Drop and recreate tables in dependency order
  await sql('DROP TABLE IF EXISTS public.embed_comments CASCADE');
  await sql('DROP TABLE IF EXISTS public.embed_posts CASCADE');
  await sql('DROP TABLE IF EXISTS public.embed_authors CASCADE');

  await sql(`
    CREATE TABLE public.embed_authors (
      id     serial PRIMARY KEY,
      name   text NOT NULL,
      active boolean NOT NULL DEFAULT true
    )
  `);

  await sql(`
    CREATE TABLE public.embed_posts (
      id        serial PRIMARY KEY,
      author_id int NOT NULL REFERENCES public.embed_authors(id),
      title     text NOT NULL,
      published boolean NOT NULL DEFAULT false
    )
  `);

  await sql(`
    CREATE TABLE public.embed_comments (
      id      serial PRIMARY KEY,
      post_id int NOT NULL REFERENCES public.embed_posts(id),
      body    text NOT NULL
    )
  `);

  // Refresh proxy catalog so it knows about the new tables
  const refreshRes = await api('POST', '/api/catalog/refresh', {}, SRV);
  if (refreshRes.status !== 200) {
    throw new Error(`Catalog refresh failed: ${JSON.stringify(refreshRes.json)}`);
  }
  console.log('  catalog refreshed');

  // Insert authors
  const authorsRes = await api('POST', '/rest/v1/embed_authors', [
    { name: 'Alice', active: true },
    { name: 'Bob',   active: true },
    { name: 'Carol', active: false },
  ], SRV);

  if (!Array.isArray(authorsRes.json) || authorsRes.json.length !== 3) {
    throw new Error(`Setup failed: expected 3 authors, got ${JSON.stringify(authorsRes.json)}`);
  }

  const [alice, bob, carol] = authorsRes.json;

  // Insert posts: Alice has 2, Bob has 1, Carol has 0
  const postsRes = await api('POST', '/rest/v1/embed_posts', [
    { author_id: alice.id, title: 'Alice Post 1', published: true  },
    { author_id: alice.id, title: 'Alice Post 2', published: false },
    { author_id: bob.id,   title: 'Bob Post 1',   published: true  },
  ], SRV);

  if (!Array.isArray(postsRes.json) || postsRes.json.length !== 3) {
    throw new Error(`Setup failed: expected 3 posts, got ${JSON.stringify(postsRes.json)}`);
  }

  const [alicePost1, alicePost2, bobPost1] = postsRes.json;

  // Insert comments: alicePost1 has 2 comments, bobPost1 has 1, alicePost2 has 0
  await api('POST', '/rest/v1/embed_comments', [
    { post_id: alicePost1.id, body: 'Great post!' },
    { post_id: alicePost1.id, body: 'Very helpful.' },
    { post_id: bobPost1.id,   body: 'Nice work.'   },
  ], SRV);

  console.log(`  authors: ${alice.id}(Alice), ${bob.id}(Bob), ${carol.id}(Carol)`);
  console.log(`  posts:   ${alicePost1.id}(Alice1), ${alicePost2.id}(Alice2), ${bobPost1.id}(Bob1)`);

  return { alice, bob, carol, alicePost1, alicePost2, bobPost1 };
}

// ---- Embedding Tests ----

async function testOneToMany() {
  console.log('\nTest E1: One-to-many embed (embed_authors -> embed_posts)');

  const r = await api('GET', '/rest/v1/embed_authors?select=*,embed_posts(*)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array');
  assert(r.json.length === 3, `3 authors (got ${r.json.length})`);

  const alice = r.json.find(a => a.name === 'Alice');
  assert(alice !== undefined, 'found Alice');
  assert(Array.isArray(alice.embed_posts), 'Alice.embed_posts is an array');
  assert(alice.embed_posts.length === 2, `Alice has 2 posts (got ${alice.embed_posts.length})`);
  assert(alice.embed_posts[0].title !== undefined, 'embedded post has title');
  assert(alice.embed_posts[0].author_id === alice.id, 'embedded post author_id matches');

  const bob = r.json.find(a => a.name === 'Bob');
  assert(bob !== undefined, 'found Bob');
  assert(Array.isArray(bob.embed_posts), 'Bob.embed_posts is an array');
  assert(bob.embed_posts.length === 1, `Bob has 1 post (got ${bob.embed_posts.length})`);

  // Carol has no posts — embed should return empty array
  const carol = r.json.find(a => a.name === 'Carol');
  assert(carol !== undefined, 'found Carol');
  assert(Array.isArray(carol.embed_posts), 'Carol.embed_posts is an array');
  assert(carol.embed_posts.length === 0, `Carol has 0 posts (got ${carol.embed_posts.length})`);
}

async function testManyToOne() {
  console.log('\nTest E2: Many-to-one embed (embed_posts -> embed_authors)');

  const r = await api('GET', '/rest/v1/embed_posts?select=id,title,embed_authors(*)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(Array.isArray(r.json), 'returns array');
  assert(r.json.length === 3, `3 posts (got ${r.json.length})`);

  const post = r.json[0];
  assert(post.embed_authors !== undefined, 'post has embed_authors field');
  // Many-to-one: parent has FK to child, so returns a single object, not an array
  assert(
    typeof post.embed_authors === 'object' && !Array.isArray(post.embed_authors),
    'embed_authors is a single object (not array) for many-to-one'
  );
  assert(post.embed_authors.name !== undefined, 'embedded author has name');
  assert(post.embed_authors.id !== undefined, 'embedded author has id');
}

async function testSelectiveColumns() {
  console.log('\nTest E3: Selective column embed (embed_authors -> embed_posts with only id,title)');

  const r = await api('GET', '/rest/v1/embed_authors?select=id,name,embed_posts(id,title)', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);

  const alice = r.json.find(a => a.name === 'Alice');
  assert(alice !== undefined, 'found Alice');
  assert(alice.id !== undefined, 'author has id');
  assert(alice.name !== undefined, 'author has name');
  // active was NOT in select list — should be absent
  assert(alice.active === undefined, 'author does not have active (not selected)');

  assert(Array.isArray(alice.embed_posts), 'has embed_posts array');
  const embedPost = alice.embed_posts[0];
  assert(embedPost.id !== undefined, 'embedded post has id');
  assert(embedPost.title !== undefined, 'embedded post has title');
  // author_id and published were NOT in embed select — should be absent
  assert(embedPost.author_id === undefined, 'embedded post has no author_id (not selected)');
  assert(embedPost.published === undefined, 'embedded post has no published (not selected)');
}

async function testEmptyEmbed() {
  console.log('\nTest E4: Empty embed result (author with no posts)');

  // Filter to Carol only — she has no posts
  const r = await api('GET', '/rest/v1/embed_authors?select=*,embed_posts(*)&name=eq.Carol', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 1, `1 author row (got ${r.json.length})`);

  const carol = r.json[0];
  assert(carol.name === 'Carol', 'correct author');
  assert(Array.isArray(carol.embed_posts), 'embed_posts is an array even when empty');
  assert(carol.embed_posts.length === 0, `embed_posts is empty (got ${carol.embed_posts.length})`);
}

async function testMultipleEmbeds() {
  console.log('\nTest E5: Multiple embeds in a single query (embed_posts -> embed_authors + embed_comments)');

  const r = await api(
    'GET',
    '/rest/v1/embed_posts?select=id,title,embed_authors(name),embed_comments(body)',
    null,
    SRV
  );
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 3, `3 posts (got ${r.json.length})`);

  // Each post should have both embeds present
  const alicePost1 = r.json.find(p => p.title === 'Alice Post 1');
  assert(alicePost1 !== undefined, 'found Alice Post 1');

  // Many-to-one: embed_authors is an object
  assert(typeof alicePost1.embed_authors === 'object' && !Array.isArray(alicePost1.embed_authors),
    'embed_authors is a single object');
  assert(alicePost1.embed_authors.name === 'Alice', 'embedded author name = Alice');

  // One-to-many: embed_comments is an array
  assert(Array.isArray(alicePost1.embed_comments), 'embed_comments is an array');
  assert(alicePost1.embed_comments.length === 2, `Alice Post 1 has 2 comments (got ${alicePost1.embed_comments.length})`);
  assert(alicePost1.embed_comments[0].body !== undefined, 'comment has body');

  // Alice Post 2 has no comments
  const alicePost2 = r.json.find(p => p.title === 'Alice Post 2');
  assert(alicePost2 !== undefined, 'found Alice Post 2');
  assert(Array.isArray(alicePost2.embed_comments), 'embed_comments is array for post with no comments');
  assert(alicePost2.embed_comments.length === 0, `Alice Post 2 has 0 comments (got ${alicePost2.embed_comments.length})`);
}

async function testEmbedWithParentFilter() {
  console.log('\nTest E6: Embed with parent-level filter');

  // Only published posts
  const r = await api('GET', '/rest/v1/embed_posts?select=id,title,embed_comments(body)&published=eq.true', null, SRV);
  assert(r.status === 200, `status 200 (got ${r.status})`);
  assert(r.json.length === 2, `2 published posts (got ${r.json.length})`);
  assert(r.json.every(p => p.embed_comments !== undefined), 'all posts have embed_comments field');
}

async function testEmbedNonExistentRelation() {
  console.log('\nTest E7: Embed with non-existent relation name');

  const r = await api('GET', '/rest/v1/embed_authors?select=*,nonexistent_table(id)', null, SRV);
  assert(r.status === 400 || r.status === 404, `non-existent relation -> 400 or 404 (got ${r.status})`);
  assert(r.json.error !== undefined, 'response has error field');
}

async function testEmbedNoForeignKey() {
  console.log('\nTest E8: Embed tables with no FK relationship');

  // embed_authors and embed_comments have no direct FK between them
  const r = await api('GET', '/rest/v1/embed_authors?select=*,embed_comments(body)', null, SRV);
  assert(r.status === 400, `no FK relationship -> 400 (got ${r.status})`);
  assert(r.json.error !== undefined, 'response has error field');
  assert(
    r.json.error.includes('foreign key') || r.json.error.includes('not found') || r.json.error.includes('invalid embed'),
    `error mentions FK, not found, or invalid embed (got: ${r.json.error})`
  );
}

// ---- Teardown ----

async function teardown() {
  await sql('DROP TABLE IF EXISTS public.embed_comments CASCADE');
  await sql('DROP TABLE IF EXISTS public.embed_posts CASCADE');
  await sql('DROP TABLE IF EXISTS public.embed_authors CASCADE');
  // Refresh catalog so dropped tables are removed
  await api('POST', '/api/catalog/refresh', {}, SRV);
  console.log('\nTeardown complete.');
}

// ---- Main ----

async function main() {
  console.log('=== Resource Embedding E2E Test ===');

  await setup();

  await testOneToMany();
  await testManyToOne();
  await testSelectiveColumns();
  await testEmptyEmbed();
  await testMultipleEmbeds();
  await testEmbedWithParentFilter();
  await testEmbedNonExistentRelation();
  await testEmbedNoForeignKey();

  await teardown();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Embed test error:', e);
  process.exit(1);
});
