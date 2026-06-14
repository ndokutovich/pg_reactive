#!/usr/bin/env node
// FR-B.11.3 — CI/CD supply-chain gating guard. Asserts the deploy/release
// hardening from gemini audit rounds R3-R7 stays in place, so a future edit
// cannot silently re-open it:
//   - deploy.yml fires on workflow_run and ships ONLY the CI-verified SHA,
//     gated on conclusion==success && event==push && head_branch==master;
//   - release.yml publishes only behind a ci-gate job (green push CI for the
//     tagged commit), with publish jobs depending on it;
//   - every third-party action in deploy/release/ci is pinned to a 40-hex
//     commit SHA, never a mutable @vN tag (a tag move would inject code into a
//     credentialed deploy/release run).
//
// Run: node tests/ci_supply_chain_test.mjs   (cwd = repo root; runs in test-cli)
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, msg) => { ok ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), fail++); };
const read = (p) => readFileSync(`.github/workflows/${p}`, "utf-8");

const deploy = read("deploy.yml");
const release = read("release.yml");
const ci = read("ci.yml");

console.log("=== CI/CD supply-chain gating (FR-B.11.3) ===");

// --- deploy gating ---
check(/^\s*workflow_run:/m.test(deploy), "deploy.yml triggers on workflow_run (CI-completed)");
check(/workflow_run\.conclusion == 'success'/.test(deploy), "deploy gated on CI conclusion == success");
check(/head_branch == 'master'/.test(deploy), "deploy gated on head_branch == master");
check(/workflow_run\.head_sha/.test(deploy), "deploy ships the CI-verified head_sha");

// --- release gating: EVERY publish job must transitively need ci-gate ---
// (a single `needs: ci-gate` regex stays green if one of several publish jobs
//  drops the gate — parse the job graph and check each one. gemini audit R10-4)
check(/^\s*ci-gate:/m.test(release), "release.yml has a ci-gate job");
check(
  /conclusion=="success"[\s\S]*?event=="push"[\s\S]*?head_branch=="master"/.test(release),
  "release ci-gate requires green push CI on master",
);
const jobs = parseJobs(release);
const reaches = (job, seen = new Set()) => {
  if (job === "ci-gate") return true;
  if (seen.has(job)) return false;
  seen.add(job);
  return (jobs[job]?.needs ?? []).some((n) => reaches(n, seen));
};
// Require EVERY release job (except ci-gate itself) to transitively need ci-gate,
// rather than classifying "publishers" — an unknown publish method (a raw
// `docker push`, a new action) must not slip an ungated job through (R10-4/R11-4).
const gated = Object.keys(jobs).filter((j) => j !== "ci-gate");
check(gated.length > 0, `release.yml has jobs beyond ci-gate (found ${gated.length}: ${gated.join(", ")})`);
for (const j of gated) {
  check(reaches(j), `release job '${j}' is gated by ci-gate (directly or transitively)`);
}

// --- action SHA pinning across deploy / release / ci ---
const PIN = /uses:\s*([^@\s]+)@([^\s#]+)/g;
for (const [name, text] of [["deploy.yml", deploy], ["release.yml", release], ["ci.yml", ci]]) {
  const bad = [];
  for (const m of text.matchAll(PIN)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) bad.push(`${m[1]}@${m[2]}`);
  }
  check(bad.length === 0, `${name}: all actions pinned to a 40-hex SHA${bad.length ? " — UNPINNED: " + bad.join(", ") : ""}`);
}

if (fail) {
  console.error(`\nFAIL: ${fail} — CI/CD supply-chain gating regressed (gemini audit R3-R7).`);
  process.exit(1);
}
console.log("\nPASS: deploy/release gating + action SHA-pinning intact.");

// Minimal YAML-ish job parser: top-level jobs (2-space indent under `jobs:`),
// each with its raw block and its `needs:` (inline scalar or `[a, b]` list).
function parseJobs(text) {
  const jobs = {};
  let inJobs = false, cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const head = line.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (head) { cur = head[1]; jobs[cur] = { block: "", needs: [] }; continue; }
    if (/^\S/.test(line)) { inJobs = false; cur = null; continue; } // back to column 0
    if (!cur) continue;
    jobs[cur].block += line + "\n";
    const nm = line.match(/^\s+needs:\s*(.+)$/);
    if (nm) {
      const v = nm[1].trim();
      jobs[cur].needs = v.startsWith("[")
        ? v.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean)
        : [v];
    }
  }
  return jobs;
}
