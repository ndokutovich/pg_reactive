#!/usr/bin/env node
// npm audit gate with a self-expiring allowlist.
//
//   node scripts/npm-audit-gate.mjs <dir> [GHSA-... ...]
//
// Fails on any advisory of severity >= high (dev deps omitted) unless its
// GHSA id is allowlisted. An allowlisted advisory that now has a fix available
// ALSO fails: the exception exists only while upstream has no patch, and must
// be removed (and the dep bumped) the moment one ships.
import { execFileSync } from "node:child_process";

const [dir, ...allow] = process.argv.slice(2);
if (!dir) { console.error("usage: npm-audit-gate.mjs <dir> [GHSA-ids...]"); process.exit(2); }

let out;
try {
  out = execFileSync("npm", ["audit", "--json", "--omit=dev"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
} catch (e) { out = e.stdout; }
const report = JSON.parse(out);

const HIGH = new Set(["high", "critical"]);
const roots = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== "object" || !HIGH.has(via.severity)) continue;
    const id = via.url.split("/").pop();
    if (!roots.has(id)) roots.set(id, { ...via, fixAvailable: v.fixAvailable });
  }
}

let fail = false;
for (const [id, a] of roots) {
  const allowed = allow.includes(id);
  if (allowed && a.fixAvailable) {
    console.error(`EXPIRED  ${id} ${a.name} ${a.severity}: fix now available — remove from allowlist and bump`);
    fail = true;
  } else if (allowed) {
    console.log(`ALLOWED  ${id} ${a.name} ${a.severity} (no upstream fix; range ${a.range})`);
  } else {
    console.error(`FAIL     ${id} ${a.name} ${a.severity} ${a.url}`);
    fail = true;
  }
}
console.log(`${roots.size} high+ root advisories, ${[...roots.keys()].filter(i => allow.includes(i)).length} allowlisted`);
process.exit(fail ? 1 : 0);
