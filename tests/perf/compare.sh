#!/usr/bin/env bash
#
# Compare two perf runs from results.jsonl.
#
# Usage:
#   bash tests/perf/compare.sh                     # latest vs. previous
#   bash tests/perf/compare.sh <commit1> <commit2> # specific commits
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL="$DIR/results.jsonl"

if [ ! -f "$JSONL" ]; then
  echo "No results.jsonl found — run tests/perf/runner.sh first."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "Node.js required to parse JSON results."
  exit 1
fi

A="${1:-}"
B="${2:-}"

node - "$JSONL" "$A" "$B" <<'EOF'
const fs   = require('fs');
const file = process.argv[2];
const argA = process.argv[3] || '';
const argB = process.argv[4] || '';

const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
const records = lines.map(l => JSON.parse(l));

function pick(commit) {
  if (!commit) return null;
  return records.find(r => r.commit === commit || r.date === commit) || null;
}

let a, b;
if (argA && argB) {
  a = pick(argA);
  b = pick(argB);
  if (!a) { console.error(`Commit/date not found: ${argA}`); process.exit(1); }
  if (!b) { console.error(`Commit/date not found: ${argB}`); process.exit(1); }
} else {
  if (records.length < 2) {
    console.log('Need at least 2 runs to compare. Only 1 found:');
    console.log(JSON.stringify(records[0], null, 2));
    process.exit(0);
  }
  b = records[records.length - 1];  // latest
  a = records[records.length - 2];  // previous
}

const allKeys = new Set([
  ...Object.keys(a.metrics || {}),
  ...Object.keys(b.metrics || {}),
]);

console.log(`\n${'─'.repeat(60)}`);
console.log(` PERF COMPARISON`);
console.log(` Base : ${a.commit} (${a.date})  ${a.suite === 'fail' ? '❌' : '✅'}`);
console.log(` Head : ${b.commit} (${b.date})  ${b.suite === 'fail' ? '❌' : '✅'}`);
console.log(`${'─'.repeat(60)}`);
console.log(` ${'Metric'.padEnd(28)} ${'Base'.padStart(10)} ${'Head'.padStart(10)} ${'Delta'.padStart(10)}`);
console.log(`${'─'.repeat(60)}`);

for (const key of [...allKeys].sort()) {
  const av = a.metrics?.[key];
  const bv = b.metrics?.[key];
  if (av == null && bv == null) continue;

  const avN = Number(av);
  const bvN = Number(bv);
  let delta = '';
  if (!isNaN(avN) && !isNaN(bvN) && avN !== 0) {
    const pct = ((bvN - avN) / Math.abs(avN)) * 100;
    const sign = pct > 0 ? '+' : '';
    // For latency metrics (ms), increase = regression; for TPS, increase = improvement.
    const isLatency = key.includes('ms') || key.includes('latency') || key.includes('p50') || key.includes('p95');
    const bad = isLatency ? pct > 10 : pct < -10;
    delta = `${sign}${pct.toFixed(1)}%${bad ? ' ⚠' : ''}`;
  }

  const label = key.padEnd(28);
  const aStr = (av != null ? String(av) : 'n/a').padStart(10);
  const bStr = (bv != null ? String(bv) : 'n/a').padStart(10);
  console.log(` ${label} ${aStr} ${bStr} ${delta.padStart(10)}`);
}

console.log(`${'─'.repeat(60)}\n`);
EOF
