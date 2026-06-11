#!/usr/bin/env node
// check-docs-parity.mjs — fail when the standalone pg_reactive extension docs
// drift from the C source of truth.
//
// Two fact-dense surfaces are most prone to silent drift:
//   1. The GUC list. SoT = DefineCustom*Variable("pg_reactive.<name>", ...) in
//      ext/src/*.c. Every GUC the extension actually registers MUST appear in
//      docs/site/pg-reactive/gucs.md — so "added a GUC, forgot the docs" fails CI.
//   2. The NOTIFY wire contract. The delta/overflow/invalidated/subscribed shapes
//      MUST appear in docs/site/pg-reactive/wire-format.md.
//
// Mirrors the discipline of scripts/sync-cli-bootstrap.mjs (init.sql -> CLI
// template parity): codify the class of mistake, not just the instance.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const C_DIR = join(ROOT, 'ext', 'src');
const GUCS_DOC = join(ROOT, 'docs', 'site', 'pg-reactive', 'gucs.md');
const WIRE_DOC = join(ROOT, 'docs', 'site', 'pg-reactive', 'wire-format.md');

let failures = 0;
const fail = (m) => {
  console.error('  ✗ ' + m);
  failures++;
};
const pass = (m) => console.log('  ✓ ' + m);

// 1) GUC names from the C source of truth.
function extractGucs() {
  const names = new Set();
  for (const f of readdirSync(C_DIR).filter((n) => n.endsWith('.c'))) {
    const src = readFileSync(join(C_DIR, f), 'utf8');
    const re = /DefineCustom\w+Variable\s*\(([\s\S]{0,200}?)"pg_reactive\.([a-z_]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[2]);
  }
  return [...names].sort();
}

const gucs = extractGucs();
if (gucs.length === 0) {
  fail('no GUCs extracted from ext/src/*.c — the extractor regex is broken');
} else {
  console.log(`GUC source of truth (ext/src/*.c): ${gucs.join(', ')}`);
}

const gucsDoc = readFileSync(GUCS_DOC, 'utf8');
for (const g of gucs) {
  if (gucsDoc.includes('pg_reactive.' + g)) pass(`gucs.md documents pg_reactive.${g}`);
  else fail(`gucs.md is MISSING pg_reactive.${g} (registered in C, absent from the docs)`);
}

// 2) Wire-format contract tokens.
const wireDoc = readFileSync(WIRE_DOC, 'utf8');
const wireTokens = [
  '"inserted"',
  '"deleted"',
  '"query_id"',
  '"seq"',
  'overflow',
  'invalidated',
  'subscribed',
];
for (const t of wireTokens) {
  if (wireDoc.includes(t)) pass(`wire-format.md documents ${t}`);
  else fail(`wire-format.md is MISSING wire token ${t}`);
}

if (failures) {
  console.error(`\nDocs parity: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nDocs parity: OK');
