#!/usr/bin/env node
// Static-asset path guard.
//
// public/index.html is served by the proxy's PublicSPA catch-all (main.go:600)
// for ANY unmatched path — including deep ones like /docs/intro. A relative
// asset reference (`href="style.css"`) then resolves against the request path
// (/docs/intro/style.css), which the catch-all answers with index.html itself
// (Content-Type text/html), so the browser refuses the stylesheet:
//   "The stylesheet … was not loaded because its MIME type, 'text/html',
//    is not 'text/css'."
//
// Every <link href>, <script src>, <img src>, <source src/srcset> in a page
// that can be served at an arbitrary depth MUST be root-absolute (/...) or a
// full URL — never path-relative. This test fails on any relative asset ref.

import { readFileSync, existsSync } from 'node:fs';

const FILES = [
  'public/index.html',
  'docs/pgstack-landing/index.html',
];

// Attribute carries an asset URL that the browser fetches as a sub-resource.
const ASSET_ATTRS = [
  { tag: 'link', attr: 'href' },
  { tag: 'script', attr: 'src' },
  { tag: 'img', attr: 'src' },
  { tag: 'source', attr: 'src' },
  { tag: 'source', attr: 'srcset' },
];

// A value is safe if it is root-absolute, a full/protocol-relative URL, or an
// inline/non-fetched scheme.
function isAbsolute(v) {
  return (
    v.startsWith('/') ||
    v.startsWith('http://') ||
    v.startsWith('https://') ||
    v.startsWith('//') ||
    v.startsWith('data:') ||
    v.startsWith('blob:') ||
    v.startsWith('#') ||
    v.startsWith('mailto:')
  );
}

const violations = [];

for (const f of FILES) {
  if (!existsSync(f)) continue;
  const text = readFileSync(f, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const { tag, attr } of ASSET_ATTRS) {
    // Match <tag ... attr="value" ...> across the (single-line) tag.
    const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'gi');
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        const val = m[1].trim();
        if (!isAbsolute(val)) {
          violations.push({ file: f, line: i + 1, tag, attr, val });
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log('OK — all asset references are root-absolute or full URLs.');
  process.exit(0);
}

console.error(`\n${violations.length} relative asset reference(s) — these break when the page is served at a sub-path:\n`);
for (const v of violations) {
  console.error(`  X ${v.file}:${v.line}  <${v.tag} ${v.attr}="${v.val}">  -> use "/${v.val}"`);
}
console.error('\nServed-at-any-depth pages must use root-absolute asset paths.');
process.exit(1);
