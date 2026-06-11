#!/usr/bin/env node
// License consistency guard.
//
// The project is dual-licensed: the pg_reactive extension (ext/) under the
// PostgreSQL License, everything else under Apache-2.0. "MIT" / "GPL" are NOT
// this project's license, yet stale "MIT licensed" copy kept resurfacing in
// landing drafts, a repo report, a roadmap note, and a spec comparison table
// (round 39). This codifies the class: any whole-word MIT/GPL/AGPL/LGPL token
// in our own files is flagged — so a wrong license claim can't sit in the repo.
//
// Legitimate third-party attributions (a dependency's OWN license) live in
// NOTICE and in generated reports, which are allow-listed. Override a verified
// third-party reference anywhere else with `lint:allow=license` on the line.
//
//   node tests/license_consistency_test.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const ROOTS = [
  'docs', 'public', 'ext', 'proxy-go', 'proxy', 'sdk', 'cli', 'studio',
  'apps', 'examples', 'deploy', 'scripts', 'tests',
];
const TOP_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md'];

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'target', '.docusaurus', '.git',
  '.stryker-tmp', '.cache', '.playwright-mcp', 'playwright-report',
]);
// Allow-listed files: third-party attribution (NOTICE) and generated reports.
const SKIP_FILES = new Set([
  'NOTICE', 'package-lock.json', 'Cargo.lock', 'go.sum',
  'license_consistency_test.mjs', // this linter names the forbidden tokens
]);
const SKIP_NAME_RE = /(playwright-report|-report\.html$|\.lock$|\.min\.(js|css)$)/i;
// Only scan text-ish files.
const SCAN_EXT_RE = /\.(md|mdx|html|htm|txt|json|toml|ts|tsx|js|mjs|cjs|go|rs|c|h|sql|yml|yaml|sh|control)$/i;

// Tokens that are NEVER this project's license. (Apache / PostgreSQL are ours.)
const FORBIDDEN = /\b(MIT|A?GPL(?:v?[0-9])?|LGPL)\b/;

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, acc);
    else if (SCAN_EXT_RE.test(name) && !SKIP_FILES.has(name) && !SKIP_NAME_RE.test(p)) acc.push(p);
  }
  return acc;
}

const files = [];
for (const r of ROOTS) walk(join(ROOT, r), files);
for (const f of TOP_FILES) { const p = join(ROOT, f); try { statSync(p); files.push(p); } catch {} }

const violations = [];
for (const f of files) {
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=license/.test(line)) continue;
    const m = FORBIDDEN.exec(line);
    if (m) violations.push({ file: relative(ROOT, f), line: i + 1, token: m[1], text: line.trim().slice(0, 100) });
  }
}

if (violations.length === 0) {
  console.log('OK — no stray MIT/GPL license tokens in project files.');
  process.exit(0);
}

console.error(`\n${violations.length} non-project license token(s) — this repo is PostgreSQL (ext/) + Apache-2.0:\n`);
for (const v of violations) {
  console.error(`  X ${v.file}:${v.line}  [${v.token}]  ${v.text}`);
}
console.error('\nFix the claim, or add `lint:allow=license` if it is a verified third-party attribution.');
process.exit(1);
