#!/usr/bin/env bash
#
# Generates a self-contained HTML trend chart from tests/perf/results.jsonl.
# Detects regressions vs the previous run (>15% regression on any latency
# metric, or >15% drop on any throughput metric).
#
# Usage:
#   bash tests/perf/chart.sh                    # writes docs/perf-trends.html
#   bash tests/perf/chart.sh --check-regression # exits 1 if any metric regressed
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
JSONL="$DIR/results.jsonl"
OUT="$DIR/../../docs/perf-trends.html"
CHECK_REGRESSION=0

for arg in "$@"; do
  [[ "$arg" == "--check-regression" ]] && CHECK_REGRESSION=1
done

if [ ! -f "$JSONL" ]; then
  echo "No results.jsonl — run tests/perf/runner.sh first." >&2
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "node required" >&2; exit 1
fi

node - "$JSONL" "$OUT" "$CHECK_REGRESSION" <<'JSEOF'
const fs   = require('fs');
const path = require('path');

const [,, jsonlPath, outPath, checkReg] = process.argv;
const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
if (lines.length === 0) { console.error('No data in results.jsonl'); process.exit(1); }

const records = lines.map(l => JSON.parse(l));

// Collect all metric names across all records.
const allMetrics = new Set();
for (const r of records) {
  for (const k of Object.keys(r.metrics || {})) allMetrics.add(k);
}
const metrics = [...allMetrics].sort();

// Build per-metric time series.
const series = {};
const labels = records.map(r => `${r.commit || '?'}\n${r.date || ''}`);
for (const m of metrics) {
  series[m] = records.map(r => {
    const v = r.metrics?.[m];
    return v != null ? Number(v) : null;
  });
}

// Regression check: compare last two runs.
let regressionFound = false;
if (checkReg === '1' && records.length >= 2) {
  const prev = records[records.length - 2];
  const curr = records[records.length - 1];
  for (const m of metrics) {
    const pv = prev.metrics?.[m];
    const cv = curr.metrics?.[m];
    if (pv == null || cv == null) continue;
    const pct = ((Number(cv) - Number(pv)) / Math.abs(Number(pv))) * 100;
    const isLatency = m.includes('ms') || m.includes('latency') || m.includes('p50') || m.includes('p95');
    const regressed = isLatency ? pct > 15 : pct < -15;
    if (regressed) {
      console.error(`REGRESSION: ${m}: ${pv} → ${cv} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`);
      regressionFound = true;
    }
  }
}

// Palette for chart lines.
const PALETTE = ['#58a6ff','#3fb950','#d29922','#f85149','#a371f7','#79c0ff','#56d364','#ffa657'];

const chartDatasets = metrics.map((m, i) => ({
  label: m,
  data: series[m],
  borderColor: PALETTE[i % PALETTE.length],
  backgroundColor: PALETTE[i % PALETTE.length] + '22',
  tension: 0.3,
  spanGaps: true,
}));

const latestRun = records[records.length - 1];
const prevRun = records.length >= 2 ? records[records.length - 2] : null;

// Build metric summary table rows.
let tableRows = '';
for (const m of metrics) {
  const cv = latestRun.metrics?.[m];
  const pv = prevRun?.metrics?.[m];
  let delta = '';
  if (cv != null && pv != null) {
    const pct = ((Number(cv) - Number(pv)) / Math.abs(Number(pv))) * 100;
    const sign = pct > 0 ? '+' : '';
    const isLatency = m.includes('ms') || m.includes('latency') || m.includes('p50') || m.includes('p95');
    const bad = isLatency ? pct > 15 : pct < -15;
    const color = bad ? '#f85149' : Math.abs(pct) < 2 ? '#8b949e' : pct > 0 ? '#3fb950' : '#f85149';
    delta = `<span style="color:${color}">${sign}${pct.toFixed(1)}%</span>`;
  }
  tableRows += `<tr><td>${m}</td><td>${cv ?? 'n/a'}</td><td>${pv ?? 'n/a'}</td><td>${delta}</td></tr>\n`;
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pgStack Performance Trends</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
h1{font-size:1.4rem;color:#e6edf3;margin-bottom:4px}
.meta{color:#8b949e;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:16px}
.card h2{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
canvas{width:100%!important;max-height:280px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
td{color:#c9d1d9}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px}
.pass{background:#0d3d17;color:#3fb950}
.fail{background:#3d0c0c;color:#f85149}
</style>
</head>
<body>
<h1>pgStack Performance Trends</h1>
<p class="meta">Generated ${new Date().toUTCString()} · ${records.length} run(s) · Latest: ${latestRun.commit || '?'} ${latestRun.date || ''} <span class="badge ${latestRun.suite === 'fail' ? 'fail' : 'pass'}">${latestRun.suite === 'fail' ? 'FAIL' : 'PASS'}</span></p>

<div class="grid">
<div class="card" style="grid-column:1/-1">
  <h2>All Metrics Over Time</h2>
  <canvas id="trend"></canvas>
</div>
</div>

<div class="card">
<h2>Latest vs Previous Run</h2>
<table>
<thead><tr><th>Metric</th><th>Latest (${latestRun.commit || '?'})</th><th>Previous (${prevRun?.commit || 'n/a'})</th><th>Delta</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</div>

<script>
const LABELS = ${JSON.stringify(labels)};
const DATASETS = ${JSON.stringify(chartDatasets)};

// Minimal Chart.js-compatible implementation using Canvas 2D.
// Draws a line chart without any external dependency.
(function() {
  const canvas = document.getElementById('trend');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * devicePixelRatio;
  canvas.height = 280 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const W = canvas.offsetWidth, H = 280;
  const PAD = { top: 20, right: 20, bottom: 50, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Find global min/max.
  let minV = Infinity, maxV = -Infinity;
  for (const ds of DATASETS) {
    for (const v of ds.data) {
      if (v != null) { minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    }
  }
  if (!isFinite(minV)) { minV = 0; maxV = 1; }
  const range = maxV - minV || 1;

  function toX(i) { return PAD.left + (i / Math.max(LABELS.length - 1, 1)) * plotW; }
  function toY(v) { return PAD.top + (1 - (v - minV) / range) * plotH; }

  // Background.
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, W, H);

  // Grid lines.
  ctx.strokeStyle = '#21262d'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW, y); ctx.stroke();
    const val = maxV - (i / 4) * range;
    ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), PAD.left - 4, y + 4);
  }

  // X labels.
  ctx.fillStyle = '#8b949e'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
  for (let i = 0; i < LABELS.length; i++) {
    ctx.fillText(LABELS[i].split('\\n')[0], toX(i), H - PAD.bottom + 14);
  }

  // Series.
  for (const ds of DATASETS) {
    ctx.strokeStyle = ds.borderColor; ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ds.data.length; i++) {
      if (ds.data[i] == null) { started = false; continue; }
      if (!started) { ctx.moveTo(toX(i), toY(ds.data[i])); started = true; }
      else ctx.lineTo(toX(i), toY(ds.data[i]));
    }
    ctx.stroke();
    // Dots.
    for (let i = 0; i < ds.data.length; i++) {
      if (ds.data[i] == null) continue;
      ctx.fillStyle = ds.borderColor;
      ctx.beginPath(); ctx.arc(toX(i), toY(ds.data[i]), 3, 0, Math.PI*2); ctx.fill();
    }
  }

  // Legend.
  let lx = PAD.left, ly = H - 14;
  for (const ds of DATASETS) {
    ctx.fillStyle = ds.borderColor;
    ctx.fillRect(lx, ly - 8, 12, 2);
    ctx.fillStyle = '#c9d1d9'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(ds.label, lx + 15, ly);
    lx += ctx.measureText(ds.label).width + 30;
    if (lx > W - 80) break;
  }
})();
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log(`Written: ${outPath}`);

if (regressionFound) {
  console.error('Performance regression detected — see above.');
  process.exit(1);
}
JSEOF
