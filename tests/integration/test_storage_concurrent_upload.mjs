// Integration test for audit F1 round 17 + strengthened in round 18.
//
// Two concurrent same-key uploads must serialise via the per-key advisory
// lock the upload handler now takes (pg_advisory_xact_lock on
// hashtext(bucket)/hashtext(name)). Without the lock the DB upsert and
// the os.Rename can interleave as DB(A→B) + rename(B→A), leaving the
// row metadata describing B while the file on disk is A's bytes. With
// the lock the two writes run strictly sequentially and the (DB, FS)
// pair stays consistent.
//
// Round-18 strengthening: every writer uses a DIFFERENT body size (and a
// different MIME type), so the consistency check actually exercises the
// metadata/file pairing. Earlier the test sent identical 1024-byte
// bodies, so even a DB(A)/file(B) mismatch would have passed the
// `size == 1024` assertion. Now we read the downloaded bytes, identify
// the winning writer via the embedded sequence in the first 8 bytes,
// and assert that the row's size AND mime_type match exactly what that
// writer uploaded.
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

// Per-writer payload shape: each writer's body has a distinct size and a
// distinct MIME so an interleave between DB metadata and the on-disk
// file is detectable.
const BASE_SIZE = 1024;
const SIZE_STEP = 256; // writer i uploads BASE_SIZE + i*SIZE_STEP bytes
const MIMES = [
  'application/octet-stream',
  'application/x-pgstack-1',
  'application/x-pgstack-2',
  'application/x-pgstack-3',
  'application/x-pgstack-4',
  'application/x-pgstack-5',
  'application/x-pgstack-6',
  'application/x-pgstack-7',
  'application/x-pgstack-8',
  'application/x-pgstack-9',
  'application/x-pgstack-a',
  'application/x-pgstack-b',
  'application/x-pgstack-c',
  'application/x-pgstack-d',
  'application/x-pgstack-e',
  'application/x-pgstack-f',
];

const writerSize = (seq) => BASE_SIZE + seq * SIZE_STEP;
const writerMime = (seq) => MIMES[seq % MIMES.length];

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

// assertDiskBackend confirms the proxy is running with STORAGE_BACKEND=disk
// — that's the only mode the per-key advisory lock matters in. On the
// database backend the data column carries the bytes and the lock path
// is never exercised, so a green test wouldn't say anything about the
// fix this file is meant to pin. Audit F2 round 19.
async function assertDiskBackend(seqProbe) {
  await uploadOnce(seqProbe);
  const dataLen = psql(
    `SELECT COALESCE(octet_length(data)::text, 'null')
     FROM pgstack.storage_objects
     WHERE bucket_id = '${BUCKET}' AND name = '${KEY}';`,
  );
  // Clean up probe row before the real run.
  psql(
    `DELETE FROM pgstack.storage_objects
     WHERE bucket_id = '${BUCKET}' AND name = '${KEY}';`,
  );
  if (dataLen !== 'null') {
    console.error(
      `\nTest aborted: storage_objects.data is ${dataLen} bytes (database backend).\n` +
      `This test only validates the advisory-lock path that the disk backend uses.\n` +
      `Restart the proxy with STORAGE_BACKEND=disk to exercise it.`,
    );
    process.exit(2);
  }
  console.log('# proxy confirmed running with STORAGE_BACKEND=disk');
}

async function uploadOnce(seq) {
  // Body: first 8 bytes = seq, remainder zero-filled to writerSize(seq).
  const size = writerSize(seq);
  const body = new Uint8Array(size);
  new DataView(body.buffer).setBigUint64(0, BigInt(seq), false);

  const mime = writerMime(seq);
  const form = new FormData();
  form.append('file', new Blob([body], { type: mime }), `${seq}.bin`);

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
  const [sizeStr, mimeStr] = row.split('|');
  return { size: Number(sizeStr), mime: mimeStr };
}

async function downloadObject() {
  const res = await fetch(`${PROXY}/storage/v1/object/${BUCKET}/${KEY}`, {
    headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
  });
  if (res.status !== 200) {
    throw new Error(`download returned ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const seq = Number(new DataView(buf.buffer).getBigUint64(0, false));
  return { bytes: buf, size: buf.length, seq };
}

async function main() {
  console.log(`# pgStack storage concurrent-upload integration test (×${CONCURRENCY}, round 19)`);
  await setup();
  // Sanity-check: this test only exercises the advisory-lock path that
  // the disk backend uses. Fail loudly if the proxy is running on the
  // database backend so a green result cannot be misread.
  await assertDiskBackend(0);

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

  // Identify the winning writer via the seq embedded in the on-disk
  // bytes, then assert that the DB row's size AND mime match what
  // THAT writer uploaded. Without the per-key advisory lock, the
  // metadata could be from a different writer than the bytes.
  const downloaded = await downloadObject();
  if (downloaded.seq < 0 || downloaded.seq >= CONCURRENCY) {
    fail(`file's embedded sequence ${downloaded.seq} is out of range`);
  } else {
    pass(`file's embedded sequence (${downloaded.seq}) is one of the contended writers`);
  }

  const expected = {
    size: writerSize(downloaded.seq),
    mime: writerMime(downloaded.seq),
  };
  if (downloaded.size !== expected.size) {
    fail(`downloaded byte length ${downloaded.size} != expected ${expected.size} for writer ${downloaded.seq}`);
  } else {
    pass(`downloaded byte length matches writer ${downloaded.seq}'s payload (${expected.size}B)`);
  }

  const meta = await readDBMetadata();
  if (meta.size !== expected.size) {
    fail(`metadata size ${meta.size} does not match winning writer ${downloaded.seq}'s size ${expected.size} ` +
         `— DB metadata describes a different writer than the bytes on disk (advisory lock failed)`);
  } else {
    pass(`metadata size matches winning writer ${downloaded.seq}'s payload (${meta.size}B)`);
  }
  if (meta.mime !== expected.mime) {
    fail(`metadata mime ${meta.mime} does not match winning writer ${downloaded.seq}'s mime ${expected.mime} ` +
         `— DB metadata describes a different writer than the bytes on disk (advisory lock failed)`);
  } else {
    pass(`metadata mime matches winning writer ${downloaded.seq}'s payload (${meta.mime})`);
  }

  if (failed === 0) {
    console.log(`\nAll checks passed (${CONCURRENCY} concurrent uploads, 1 row, file+metadata both from writer ${downloaded.seq}).`);
    process.exit(0);
  } else {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
