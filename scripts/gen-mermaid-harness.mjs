#!/usr/bin/env node
// Extract every ```mermaid block from the docs and emit a self-contained HTML
// harness that runs mermaid.parse() on each (real browser engine, via CDN) and
// prints PASS/FAIL. Docusaurus renders mermaid client-side, so the static build
// never catches a syntax error — this does. Open the emitted file with a
// browser (Playwright) and read the results.
//
//   node scripts/gen-mermaid-harness.mjs
//   -> writes /tmp/mermaid_check.html  (and prints the block count)

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['docs/site/docs', 'docs/site/pg-reactive'];
const EXTRA = ['README.md', 'ext/README.md'];

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const n of entries) {
    const p = join(dir, n);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, acc);
    else if (n.endsWith('.md') || n.endsWith('.mdx')) acc.push(p);
  }
  return acc;
}

const files = [];
for (const r of ROOTS) walk(join(ROOT, r), files);
for (const e of EXTRA) files.push(join(ROOT, e));

const blocks = [];
const re = /```mermaid\r?\n([\s\S]*?)```/g;
for (const f of files) {
  let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
  let m, i = 0;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ file: f.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''), idx: i++, code: m[1] });
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>mermaid check</title></head>
<body><pre id="out">running…</pre>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/+esm';
mermaid.initialize({ startOnLoad: false });
const blocks = ${JSON.stringify(blocks)};
const out = document.getElementById('out');
let pass = 0; const fails = [];
for (const b of blocks) {
  try { await mermaid.parse(b.code); pass++; }
  catch (e) { fails.push(b.file + ' #' + b.idx + ': ' + (e && e.message ? e.message.split('\\n')[0] : e)); }
}
out.textContent = 'MERMAID_RESULT ' + JSON.stringify({ total: blocks.length, pass, fail: fails.length, fails }, null, 2);
</script></body></html>`;

const outPath = join(ROOT, 'mermaid_check.html');
writeFileSync(outPath, html);
console.log(`Extracted ${blocks.length} mermaid block(s) from ${files.length} files -> ${outPath}`);
