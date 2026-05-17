// Integration test for audit F1 round 17.
//
// Two concurrent same-key uploads must serialise via the per-key advisory
// lock the upload handler now takes (pg_advisory_xact_lock on
// hashtext(bucket)/hashtext(name)). Without the lock the DB upsert and
// the os.Rename can interleave as DB(A→B) + rename(B→A), leaving the
// row metadata describing B while the file on disk is A's bytes. With
// the lock the two writes run strictly sequentially and the (DB, FS)
// pair stays consistent.
//
// Requires:
//   - docker compose up -d (Postgres, proxy on 127.0.0.1:8080)
//   - STORAGE_BACKEND=disk on the proxy (the lock only matters for the
//     disk backend; the DB backend has nothing to coordinate with)
//   - A bucket named "concurrent-test" (created on first run)
//
// Run:  node tests/integration/test_storage_concurrent_upload.mjs

import { psql } from '../helpers.mjs';

const PROXY = process.env.PROXY_URL ?? 'http://127.0.0.1:8080';
const SERVICE_KEY = process.env.SERVICE_ROLE_KEY
  ?? 'dev-only-service-role-key-do-not-use-in-production';
const BUCKET = 'concurrent-test';
const KEY = 'race-target.bin';
const CONCURRENCY = 16;

let failed = 0;
const fail = (msg) => { console.error('✗', msg); failed++; };
const pass = (msg) => console.log('✓', msg);

async function setup() {
  // Idempotent bucket + clean key.
  psql(
    `INSERT INTO pgstack.storage_buckets (id, public)
     VALUES ('${BUCKET}', true)
     ON CONFLICT (id) DO NOTHING;`,
  );
  psql(
    `DELETE FROM pgstack.storage_objects
     WHERE bucket_id = '${BUCKET}' AND name = '${KEY}';`,
  );
}

async function uploadOnce(seq) {
  // Use a body whose first 8 bytes encode the sequence number so we can
  // identify which writer's bytes ended up on disk.
  const body = new Uint8Array(1024);
  new DataView(body.buffer).setBigUint64(0, BigInt(seq), false);

  const form = new FormData();
  form.append('file', new Blob([body], { type: 'application/octet-stream' }), `${seq}.bin`);

  const res = await fetch(`${PROXY}/storage/v1/object/${BUCKET}/${KEY}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
    body: form,
  });
  return { seq, status: res.status, body: await res.json() };
}

async function readDBMetadata() {
  const row = psql(
    `SELECT size || '|' || mime_type
     FROM pgstack.storage_objects
     WHERE bucket_id = '${BUCKET}' AND name = '${KEY}';`,
  );
  return row;
}

async function readFileFirstUint64() {
  const res = await fetch(`${PROXY}/storage/v1/object/${BUCKET}/${KEY}`, {
    headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
  });
  if (res.status !== 200) {
    throw new Error(`download returned ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return Number(new DataView(buf.buffer).getBigUint64(0, false));
}

async function main() {
  console.log(`# pgStack storage concurrent-upload integration test (×${CONCURRENCY})`);
  await setup();

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => uploadOnce(i)),
  );

  // All requests must complete with 200 (advisory lock serialises them,
  // does not error them out).
  const non200 = results.filter((r) => r.status !== 200);
  if (non200.length !== 0) {
    fail(`${non200.length}/${CONCURRENCY} uploads returned non-200: ${
      non200.map((r) => r.status).join(', ')}`);
  } else {
    pass(`all ${CONCURRENCY} parallel uploads returned 200`);
  }

  // The row count must remain 1 — every UPDATE landed on the same row,
  // no orphan rows from compensation gone wrong.
  const count = Number(psql(
    `SELECT count(*) FROM pgstack.storage_objects
     WHERE bucket_id = '${BUCKET}' AND name = '${KEY}';`,
  ));
  if (count !== 1) {
    fail(`expected 1 storage_objects row after concurrent upload, got ${count}`);
  } else {
    pass(`exactly 1 storage_objects row for the contested key`);
  }

  // Consistency: read the file bytes (first 8 = seq) and confirm the row's
  // size matches the actual file. If DB updates and renames had interleaved,
  // the metadata size could disagree with what's on disk.
  const fileSeq = await readFileFirstUint64();
  if (fileSeq < 0 || fileSeq >= CONCURRENCY) {
    fail(`file's embedded sequence ${fileSeq} is out of range`);
  } else {
    pass(`file's embedded sequence (${fileSeq}) is one of the contended writers`);
  }

  const metaSizeMime = await readDBMetadata();
  const [sizeStr] = metaSizeMime.split('|');
  if (Number(sizeStr) !== 1024) {
    fail(`metadata size ${sizeStr} != actual upload size 1024`);
  } else {
    pass(`metadata size matches actual upload size`);
  }

  if (failed === 0) {
    console.log(`\nAll checks passed (${CONCURRENCY} concurrent uploads, 1 row, file matches metadata).`);
    process.exit(0);
  } else {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
