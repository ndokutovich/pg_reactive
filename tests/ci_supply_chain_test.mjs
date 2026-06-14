#!/usr/bin/env node
// FR-B.11.3 — CI/CD supply-chain gating guard. The deploy/release policy is
// expressed as structured functions that return a list of violations; they are
// run against (a) the REAL workflows — which must be clean — and (b) a battery
// of MANDATORY mutation self-tests, each of which the guard MUST catch. The
// mutations are the concrete bypasses found across gemini audit rounds
// R10/R11/R13/R14/R15/R16, locked in so a future weakening of the guard fails CI.
//
// Gate expressions are checked with a small GitHub-expression EVALUATOR run under
// adversarial inputs (not substrings); it FAILS CLOSED on unsupported syntax.
//
// Run: node tests/ci_supply_chain_test.mjs (cwd = repo root). Needs js-yaml in
// tests/node_modules — the test-cli CI job runs `npm ci --prefix tests`.
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

let fail = 0;
const check = (ok, msg) => { ok ? console.log(`  ✓ ${msg}`) : (console.error(`  ✗ ${msg}`), fail++); };
const load = (p) => yaml.load(readFileSync(`.github/workflows/${p}`, "utf-8"), { schema: yaml.FAILSAFE_SCHEMA }) || {};
const jobsOf = (wf) => wf.jobs || {};
const needsOf = (j) => { const n = j?.needs; return n == null ? [] : Array.isArray(n) ? n : [n]; };
const coeJob = (j) => String(j?.["continue-on-error"]) === "true";
const coeStep = (s) => String(s?.["continue-on-error"]) === "true";
const stripBraces = (s) => String(s).replace(/\$\{\{|\}\}/g, " ");

// --- GitHub Actions expression evaluator (fail-closed on unknown syntax) ------
const truthy = (v) => !(v === "" || v === 0 || v === false || v === null || v === undefined);
function evalExpr(src, ctx) {
  const T = [];
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|,|'[^']*'|[0-9]+|[A-Za-z_][\w.]*)/y;
  for (let i = 0; i < src.length;) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (src.slice(i).trim() === "") break; throw new Error("unsupported expression syntax near: " + src.slice(i, i + 16)); }
    i = re.lastIndex; T.push(m[1]);
  }
  let p = 0;
  const pk = () => T[p], ea = () => T[p++];
  const eq = (a, b) => String(a) === String(b);
  const orE = () => { let l = andE(); while (pk() === "||") { ea(); const r = andE(); l = truthy(l) ? l : r; } return l; };
  const andE = () => { let l = cmpE(); while (pk() === "&&") { ea(); const r = cmpE(); l = truthy(l) ? r : l; } return l; };
  const cmpE = () => { let l = unE(); while (pk() === "==" || pk() === "!=") { const o = ea(); const r = unE(); l = o === "==" ? eq(l, r) : !eq(l, r); } return l; };
  const unE = () => { if (pk() === "!") { ea(); return !truthy(unE()); } return prim(); };
  const prim = () => {
    const t = ea();
    if (t === undefined) throw new Error("unexpected end of expression");
    if (t === "(") { const v = orE(); if (pk() === ")") ea(); else throw new Error("unbalanced ("); return v; }
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^[0-9]+$/.test(t)) return Number(t);
    if (pk() === "(") { ea(); let d = 1; while (pk() && d) { const x = ea(); if (x === "(") d++; else if (x === ")") d--; } const f = ctx.__funcs || {}; return (t.toLowerCase() in f) ? f[t.toLowerCase()] : false; }
    let cur = ctx; for (const part of t.split(".")) cur = (cur == null) ? undefined : cur[part]; return cur === undefined ? "" : cur;
  };
  const r = orE();
  if (p !== T.length) throw new Error("trailing tokens in expression");
  return r;
}
const ev = (expr, ctx) => evalExpr(stripBraces(expr), ctx);

// Adversarial contexts. github.sha='PUSHSHA' vs workflow_run.head_sha='HEADSHA'.
const wr = (con, evt, br) => ({ github: { event_name: "workflow_run", event: { workflow_run: { conclusion: con, event: evt, head_branch: br, head_sha: "HEADSHA" } }, sha: "PUSHSHA" }, __funcs: { always: true, success: con === "success", failure: con !== "success", cancelled: false } });
const DEPLOY_CASES = [
  { ok: true, ctx: { github: { event_name: "workflow_dispatch", event: {} }, __funcs: { always: true, success: true, failure: false, cancelled: false } } },
  { ok: true, ctx: wr("success", "push", "master") },
  { ok: false, ctx: wr("failure", "push", "master") },
  { ok: false, ctx: wr("success", "pull_request", "master") },
  { ok: false, ctx: wr("success", "push", "main") },
  { ok: false, ctx: wr("success", "push", "evil-x9z") },
];
const FAIL_CTX = wr("failure", "push", "master");
// isGate: TRUE only for the ok cases; FALSE (or unparseable) otherwise → fail-closed.
const isGate = (s) => !!s && DEPLOY_CASES.every((c) => { try { return truthy(ev(s, c.ctx)) === c.ok; } catch { return false; } });
const parseable = (s) => { if (!s) return true; try { ev(s, FAIL_CTX); return true; } catch { return false; } };
const hasStatusFn = (s) => /\b(?:always|success|failure|cancelled)\s*\(/i.test(s);
const defeatsGating = (s) => { if (!s || !hasStatusFn(s)) return false; try { return truthy(ev(s, FAIL_CTX)); } catch { return true; } };
const shaResolvesRight = (expr) => { try { return ev(expr, FAIL_CTX) === "HEADSHA"; } catch { return false; } };

// --- structured policy: returns a list of violation strings --------------------
function deployPolicy(wf) {
  const v = [];
  if (!(wf.on || {}).workflow_run) v.push("no workflow_run trigger");
  const jobs = jobsOf(wf);
  const gateJobs = Object.entries(jobs).filter(([, j]) => isGate(j.if || ""));
  if (!gateJobs.length) v.push("no job whose if gates on a verified master push");
  const gated = (name, seen = new Set()) => { const j = jobs[name]; if (!j || seen.has(name)) return false; seen.add(name); if (isGate(j.if || "")) return true; return needsOf(j).some((n) => gated(n, seen)); };
  for (const [name, j] of Object.entries(jobs)) {
    if (!parseable(j.if)) v.push(`${name}: if is unparseable (cannot verify)`);
    if (!gated(name)) v.push(`${name}: not gated`);
    if (defeatsGating(j.if || "")) v.push(`${name}: if runs after a failed/skipped gate`);
    if (coeJob(j)) v.push(`${name}: job continue-on-error`);
    (j.steps || []).forEach((s, i) => coeStep(s) && v.push(`${name} step ${i}: continue-on-error`));
  }
  for (const [name, j] of gateJobs) {
    const defs = [j.env?.DEPLOY_SHA, ...(j.steps || []).map((s) => s.env?.DEPLOY_SHA)].filter((x) => typeof x === "string");
    if (!defs.length) v.push(`${name}: gate job ships no DEPLOY_SHA`);
    for (const d of defs) if (!shaResolvesRight(d)) v.push(`${name}: DEPLOY_SHA does not resolve to the verified head_sha`);
  }
  return v;
}
function releasePolicy(wf) {
  const v = [];
  const jobs = jobsOf(wf);
  const cg = jobs["ci-gate"];
  if (!cg) return ["no ci-gate job"];
  if (coeJob(cg)) v.push("ci-gate: job continue-on-error");
  (cg.steps || []).forEach((s, i) => coeStep(s) && v.push(`ci-gate step ${i}: continue-on-error`));
  const run = (cg.steps || []).map((s) => s.run || "").join("\n");
  const selects = [...run.matchAll(/select\(([^)]*)\)/g)].map((m) => m[1]);
  if (!selects.some((s) => s.includes('conclusion=="success"') && s.includes('event=="push"') && s.includes('head_branch=="master"')))
    v.push("ci-gate: jq select() does not filter conclusion==success && event==push && head_branch==master");
  if (!/[?&]event=push\b/.test(run) || !/[?&]branch=master\b/.test(run)) v.push("ci-gate: gh api query does not filter event=push&branch=master");
  if (!/\bexit\s+[1-9]/.test(run)) v.push("ci-gate: run never exits nonzero (gate cannot fail)");
  const reaches = (name, seen = new Set()) => name === "ci-gate" ? true : (!jobs[name] || seen.has(name)) ? false : (seen.add(name), needsOf(jobs[name]).some((n) => reaches(n, seen)));
  for (const [name, j] of Object.entries(jobs)) {
    if (name === "ci-gate") continue;
    if (!parseable(j.if)) v.push(`${name}: if is unparseable (cannot verify)`);
    if (!reaches(name)) v.push(`${name}: not gated by ci-gate`);
    if (defeatsGating(j.if || "")) v.push(`${name}: if runs after ci-gate is skipped/failed`);
  }
  return v;
}
function pinPolicy(wf) {
  const v = [];
  const pinned = (u) => {
    if (u.startsWith("./")) return true; // local in-repo action
    if (u.startsWith("docker://")) return /@sha256:[0-9a-f]{64}$/.test(u); // image must be digest-pinned
    const at = u.lastIndexOf("@");
    return at >= 0 && /^[0-9a-f]{40}$/.test(u.slice(at + 1));
  };
  for (const [jn, job] of Object.entries(jobsOf(wf))) {
    for (const u of [job.uses, ...(job.steps || []).map((s) => s.uses)].filter((x) => typeof x === "string"))
      if (!pinned(u)) v.push(`${jn}: uses '${u}' is not pinned to an immutable ref`);
  }
  return v;
}

const deploy = load("deploy.yml");
const release = load("release.yml");
const ci = load("ci.yml");

console.log("=== CI/CD supply-chain gating (FR-B.11.3) ===");
console.log("-- real workflows must be clean --");
const dV = deployPolicy(deploy), rV = releasePolicy(release);
check(dV.length === 0, `deploy policy clean${dV.length ? " — " + dV.join("; ") : ""}`);
check(rV.length === 0, `release policy clean${rV.length ? " — " + rV.join("; ") : ""}`);
for (const [n, wf] of [["deploy.yml", deploy], ["release.yml", release], ["ci.yml", ci]]) {
  const pv = pinPolicy(wf);
  check(pv.length === 0, `${n} pinning clean${pv.length ? " — " + pv.join("; ") : ""}`);
}

console.log("-- mandatory mutation self-tests (each must be caught) --");
const clone = (o) => JSON.parse(JSON.stringify(o));
const mut = (label, base, mutate, policy) => {
  const w = clone(base);
  mutate(w);
  check(policy(w).length > policy(base).length, `caught: ${label}`);
};
const DGATE = "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'master')";
mut("deploy if drops event==push", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'master'"; }, deployPolicy);
mut("deploy if true || conds", deploy, (w) => { w.jobs.deploy.if = "true || (" + DGATE + ")"; }, deployPolicy);
mut("deploy if allows master||main", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || github.event.workflow_run.head_branch == 'main')"; }, deployPolicy);
mut("deploy downstream if: always()", deploy, (w) => { w.jobs["deploy-polyglot"].if = "always()"; }, deployPolicy);
mut("deploy if unparseable syntax", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion =~ /success/"; }, deployPolicy);
mut("deploy DEPLOY_SHA wrong order", deploy, (w) => { w.jobs.deploy.steps[0].env.DEPLOY_SHA = "${{ github.sha || github.event.workflow_run.head_sha }}"; }, deployPolicy);
mut("deploy decoy job-env + step-env github.sha", deploy, (w) => { w.jobs.deploy.env = { DEPLOY_SHA: "${{ github.event.workflow_run.head_sha }}" }; w.jobs.deploy.steps[0].env.DEPLOY_SHA = "${{ github.sha }}"; }, deployPolicy);
mut("deploy job continue-on-error", deploy, (w) => { w.jobs.deploy["continue-on-error"] = true; }, deployPolicy);
mut("deploy step continue-on-error", deploy, (w) => { w.jobs.deploy.steps[0]["continue-on-error"] = true; }, deployPolicy);
mut("release ci-gate job continue-on-error", release, (w) => { w.jobs["ci-gate"]["continue-on-error"] = true; }, releasePolicy);
mut("release ci-gate STEP continue-on-error", release, (w) => { w.jobs["ci-gate"].steps[0]["continue-on-error"] = true; }, releasePolicy);
mut("release weaken jq + decoy echo", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/actions/workflows/ci.yml/runs?head_sha=y' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')\necho conclusion==\"success\" event==\"push\" head_branch==\"master\"\nif [ \"$n\" -lt 1 ]; then exit 1; fi"; }, releasePolicy);
mut("release publisher if: always()", release, (w) => { w.jobs["docker-proxy"].if = "always()"; }, releasePolicy);
mut("release publisher drops needs", release, (w) => { delete w.jobs["docker-proxy"].needs; }, releasePolicy);
mut("pin step uses @mutable tag", deploy, (w) => { w.jobs.deploy.steps[0].uses = "appleboy/ssh-action@v1"; }, pinPolicy);
mut("pin job-level uses @main", release, (w) => { w.jobs.evil = { uses: "attacker/wf@main" }; }, pinPolicy);
mut("pin docker://image:latest", release, (w) => { w.jobs["ci-gate"].steps.push({ uses: "docker://alpine:latest" }); }, pinPolicy);

if (fail) {
  console.error(`\nFAIL: ${fail} — CI/CD supply-chain gating regressed or the guard missed a known mutation.`);
  process.exit(1);
}
console.log("\nPASS: policy clean on real workflows; all known bypass mutations caught.");
