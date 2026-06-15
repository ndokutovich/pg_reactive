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
// A gate job/step must NOT be continue-on-error. Forbid the field unless it is
// the literal `false` — an expression value can't be statically proven false and
// would be evaluated in an unknowable event context (gemini R17-1/R18-4).
const coeBad = (x) => { const v = x?.["continue-on-error"]; return v != null && String(v).trim() !== "false"; };
const coeJob = coeBad, coeStep = coeBad;
const stripBraces = (s) => String(s).replace(/\$\{\{|\}\}/g, " ");
// Remove shell comments and echo/printf commands (they produce no gate effect),
// so decoy strings in them can't satisfy a check (gemini R17-2).
const stripNoise = (s) => s.split("\n").map((l) => {
  let x = l.replace(/(^|\s)#.*$/, "$1");          // comments
  x = x.replace(/\bfalse\s*&&[^;\n]*/g, " ");       // `false && X` — X never runs
  x = x.replace(/\btrue\s*\|\|[^;\n]*/g, " ");      // `true || X`  — X never runs
  x = x.replace(/\b(?:echo|printf|true|false|:)\b[^;\n&|]*/g, " "); // no-op / output-only commands
  return x;
}).join("\n");
// Drop UNREACHABLE shell so a correct gate snippet hidden in dead code can't
// satisfy the checks: heredoc bodies (a decoy `cat <<EOF >/dev/null … EOF`,
// R19-3), function DEFINITIONS that may never be called, and always-false
// if-blocks (`if false` / `if [ 1 -eq 0 ]`) — gemini R20-3/R20-5.
const stripDead = (s) => {
  const out = []; let heredoc = null; const skip = [];
  for (const l of s.split("\n")) {
    if (heredoc !== null) { if (l.trim() === heredoc) heredoc = null; continue; }
    if (skip.length) { if (new RegExp(`(^|[\\s;])${skip[skip.length - 1]}([\\s;]|$)`).test(l)) skip.pop(); continue; }
    const hd = l.match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (hd) { heredoc = hd[1]; out.push(l.replace(/<<-?\s*['"]?[A-Za-z_]\w*['"]?.*/, "")); continue; }
    if (/^\s*(?:function\s+)?[A-Za-z_]\w*\s*\(\)\s*\{/.test(l)) { skip.push("}"); continue; }
    const FALSE = "(?:!?\\s*false\\b|\\[\\s*1\\s+-eq\\s+0\\s*\\]|\\[\\s*0\\s+-eq\\s+1\\s*\\]|\\[\\s*1\\s*=\\s*0\\s*\\])";
    if (new RegExp("^\\s*if\\s+" + FALSE).test(l)) { skip.push("fi"); continue; }
    if (new RegExp("^\\s*while\\s+" + FALSE).test(l) || /^\s*until\s+(?:true\b|:|\[\s*1\s+-eq\s+1\s*\])/.test(l)) { skip.push("done"); continue; }
    out.push(l);
  }
  return out.join("\n");
};
// Strip ONLY `#` line comments (and, composed with stripDead, unreachable code) —
// unlike stripNoise it leaves real commands intact, so a `:` inside an image tag
// (`pgstack-proxy:sha-…`) survives. `${VAR#pat}` is safe (the `#` is not at a
// command/whitespace boundary). Used for the image-ref / promote checks (R23).
const stripComments = (s) => s.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");
// Every git reset/checkout target in a deploy script. The target must be EXACTLY
// $DEPLOY_SHA — not a branch (master), not a rev-expression ($DEPLOY_SHA^,
// "$DEPLOY_SHA"~1), not github.sha (gemini R20-2/R20-3/R20-4).
const resetTargets = (s) => [...s.matchAll(/git(?:\s+-C\s+\S+|\s+--\w[\w-]*=\S+)*\s+(?:reset|checkout|switch)(?:\s+--?\S+)*\s+(\S+)/g)].map((m) => m[1]);
const exactSha = (t) => /^\$\{?DEPLOY_SHA\}?$/.test(t.replace(/["']/g, ""));
// The gate `if` may reference ONLY these context fields. A term like
// `|| github.event.workflow_run.id` is falsy in the test context but truthy in a
// real event, so it would slip a non-gating disjunct past the evaluator (R20-1).
const ALLOWED_IF_CTX = new Set(["github.event_name", "github.event.workflow_run.conclusion", "github.event.workflow_run.event", "github.event.workflow_run.head_branch", "github.ref"]);
const unmodeledCtx = (s) => [...stripBraces(s).matchAll(/github\.[\w.]+/g)].map((m) => m[0]).filter((p) => !ALLOWED_IF_CTX.has(p));

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
    if (pk() === "(") { ea(); let d = 1; while (pk() && d) { const x = ea(); if (x === "(") d++; else if (x === ")") d--; } const f = ctx.__funcs || {}, fn = t.toLowerCase(); if (!(fn in f)) throw new Error("unsupported function: " + t); return f[fn]; }
    let cur = ctx; for (const part of t.split(".")) cur = (cur == null) ? undefined : cur[part]; return cur === undefined ? "" : cur;
  };
  const r = orE();
  if (p !== T.length) throw new Error("trailing tokens in expression");
  return r;
}
const ev = (expr, ctx) => evalExpr(stripBraces(expr), ctx);

// Adversarial contexts. github.sha='PUSHSHA' vs workflow_run.head_sha='HEADSHA'.
const wr = (con, evt, br) => ({ github: { event_name: "workflow_run", event: { workflow_run: { conclusion: con, event: evt, head_branch: br, head_sha: "HEADSHA" } }, sha: "PUSHSHA" }, __funcs: { always: true, success: con === "success", failure: con !== "success", cancelled: false } });
const wd = (ref) => ({ github: { event_name: "workflow_dispatch", event: {}, ref }, __funcs: { always: true, success: true, failure: false, cancelled: false } });
const DEPLOY_CASES = [
  { ok: true, ctx: wd("refs/heads/master") },        // manual deploy ON master — allowed
  { ok: false, ctx: wd("refs/heads/feature-x9z") },  // manual deploy on a feature branch — REFUSED (finding 3)
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
// A job can run UNTRUSTED pull_request code unless its `if` evaluates false under
// a pull_request event. Push-only-gated jobs (build-publish) thus legitimately
// hold packages:write and a self-hosted runner; a PR-reachable job must not. No
// `if` → runs on every event (true); parse error → fail closed (true). (finding 7)
const PR_CTX = { github: { event_name: "pull_request", event: {}, ref: "refs/pull/1/merge", sha: "PRSHA" }, __funcs: { always: true, success: true, failure: false, cancelled: false } };
const runsOnPR = (j) => { if (!j.if) return true; try { return truthy(ev(String(j.if), PR_CTX)); } catch { return true; } };
const shaResolvesRight = (expr) => { try { return ev(expr, FAIL_CTX) === "HEADSHA"; } catch { return false; } };
// Every comparison involving head_branch must be exactly `head_branch == 'master'`
// (or reversed) and at least one must exist — so `!=`, a self-compare, another
// branch literal, or a comparison to a context value are all rejected (gemini
// R18-3/R19-1).
const branchBad = (s) => {
  const e = stripBraces(s);
  const left = [...e.matchAll(/head_branch\s*(==|!=)\s*([^\s)&|]+)/g)];
  const right = [...e.matchAll(/'([^']*)'\s*(==|!=)\s*[\w.]*head_branch/g)];
  const goodL = (m) => m[1] === "==" && m[2] === "'master'";
  const goodR = (m) => m[2] === "==" && m[1] === "master";
  const hasGood = left.some(goodL) || right.some(goodR);
  const hasBad = left.some((m) => !goodL(m)) || right.some((m) => !goodR(m));
  return !hasGood || hasBad;
};

// --- structured policy: returns a list of violation strings --------------------
function deployPolicy(wf) {
  const v = [];
  const wrTrig = (wf.on || {}).workflow_run;
  if (!wrTrig) v.push("no workflow_run trigger");
  else {
    // pin the trigger: only the CI workflow's completion, not e.g. a Smoke
    // workflow or `types: [requested]` (gemini R18-6).
    const wfs = Array.isArray(wrTrig.workflows) ? wrTrig.workflows : (wrTrig.workflows != null ? [wrTrig.workflows] : []);
    if (!(wfs.length === 1 && wfs[0] === "CI")) v.push(`workflow_run.workflows must be exactly ["CI"], got [${wfs.join(",")}]`);
    const types = Array.isArray(wrTrig.types) ? wrTrig.types : (wrTrig.types != null ? [wrTrig.types] : []);
    if (!(types.length === 1 && types[0] === "completed")) v.push(`workflow_run.types must be [completed], got [${types.join(",")}]`);
  }
  const dExtra = Object.keys(wf.on || {}).filter((t) => t !== "workflow_run" && t !== "workflow_dispatch");
  if (dExtra.length) v.push(`unexpected trigger(s) [${dExtra.join(",")}] — deploy must trigger only on workflow_run/workflow_dispatch`);
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
    if (branchBad(j.if || "")) v.push(`${name}: if does not gate the branch to exactly master (==/!=/self-compare/other)`);
    const um = unmodeledCtx(j.if || "");
    if (um.length) v.push(`${name}: if references unmodeled context field(s) [${um.join(",")}] (truthy in a real event, slips the gate)`);
    const defs = [j.env?.DEPLOY_SHA, ...(j.steps || []).map((s) => s.env?.DEPLOY_SHA)].filter((x) => typeof x === "string");
    if (!defs.length) v.push(`${name}: gate job ships no DEPLOY_SHA`);
    for (const d of defs) if (!shaResolvesRight(d)) v.push(`${name}: DEPLOY_SHA does not resolve to the verified head_sha`);
  }
  // EVERY job — gate AND any downstream `needs: deploy` job holds the same SSH
  // credentials — must deploy only the verified $DEPLOY_SHA: no github.sha in the
  // script, and every git reset/checkout target is EXACTLY $DEPLOY_SHA (not
  // master, not a parent-rev like $DEPLOY_SHA^). At least one such reset must
  // exist. Dead code is stripped first (R20-2/R20-3/R20-4).
  const allTargets = [];
  for (const [name, j] of Object.entries(jobs)) {
    // The CI-verify gate step legitimately queries CI for github.sha — exclude it
    // from the deploy-script checks (those guard the git-reset/SSH script).
    const script = stripNoise(stripDead((j.steps || []).filter((s) => !(/gh\s+api/.test(String(s.run || "")) && /ci\.yml\/runs/.test(String(s.run || "")))).map((s) => String(s.with?.script ?? s.run ?? "")).join("\n")));
    if (/github\.sha\b/.test(script)) v.push(`${name}: deploy script references github.sha directly`);
    for (const t of resetTargets(script)) { allTargets.push(t); if (!exactSha(t)) v.push(`${name}: git reset/checkout target '${t}' is not exactly $DEPLOY_SHA`); }
  }
  if (!allTargets.length) v.push("no job git-resets/checks out the verified $DEPLOY_SHA");
  // The workflow_run path is CI-gated by the job `if`; a manual workflow_dispatch
  // is NOT, so the deploy must verify a green CI run for github.sha on master
  // before deploying — else a red master commit is hand-deployable (finding 1, R23).
  const dispatchGate = Object.values(jobs).flatMap((j) => j.steps || []).find((s) => /workflow_dispatch/.test(String(s.if || "")) && /gh\s+api/.test(String(s.run || "")));
  if (!dispatchGate) v.push("no workflow_dispatch CI-green gate (a red master commit could be hand-deployed)");
  else {
    const r = stripNoise(String(dispatchGate.run || ""));
    if (!/ci\.yml\/runs\?[^\n]*head_sha=\$\{\{\s*github\.sha\s*\}\}/.test(r) || !/[?&]event=push\b/.test(r) || !/[?&]branch=master\b/.test(r))
      v.push("workflow_dispatch gate does not query CI success for github.sha on a master push");
    if (!/(^|[\s;&|])exit\s+[1-9]/m.test(r)) v.push("workflow_dispatch gate never exits nonzero");
  }
  return v;
}
function releasePolicy(wf) {
  const v = [];
  // pin the trigger: only a tag push — no extra workflow_dispatch etc. (R18-6)
  const extra = Object.keys(wf.on || {}).filter((t) => t !== "push");
  if (extra.length) v.push(`unexpected trigger(s) [${extra.join(",")}] — release must trigger only on a tag push`);
  const rpush = (wf.on || {}).push || {};
  if (rpush.branches) v.push("release: push.branches present — must trigger on tags only, not branch pushes");
  const rtags = Array.isArray(rpush.tags) ? rpush.tags : (rpush.tags != null ? [rpush.tags] : []);
  if (!rtags.length) v.push("release must trigger on push.tags");
  if (rtags.some((t) => !/^v/.test(String(t)))) v.push(`release: tag pattern(s) [${rtags.join(",")}] not restricted to v* (a bare * matches any tag)`);
  const jobs = jobsOf(wf);
  const cg = jobs["ci-gate"];
  if (!cg) return ["no ci-gate job"];
  if (coeJob(cg)) v.push("ci-gate: job continue-on-error");
  (cg.steps || []).forEach((s, i) => coeStep(s) && v.push(`ci-gate step ${i}: continue-on-error`));
  // Strip comments + echo/printf (no gate effect) so a decoy `echo 'select(...)'`
  // / `echo 'exit 1'` can't satisfy the checks; then inspect the actual --jq arg
  // and a real exit command (R17-2).
  const run = stripNoise(stripDead((cg.steps || []).map((s) => s.run || "").join("\n")));
  const jqArgs = [...run.matchAll(/--jq\s+'([^']*)'/g)].map((m) => m[1]);
  if (!jqArgs.some((a) => a.includes('conclusion=="success"') && a.includes('event=="push"') && a.includes('head_branch=="master"')))
    v.push("ci-gate: --jq filter does not select conclusion==success && event==push && head_branch==master");
  if (!/[?&]event=push\b/.test(run) || !/[?&]branch=master\b/.test(run)) v.push("ci-gate: gh api query does not filter event=push&branch=master");
  if (!/[?&]head_sha=\$\{\{\s*github\.sha\s*\}\}/.test(run)) v.push("ci-gate: gh api query does not bind to the tagged commit (head_sha=github.sha)");
  if (!/(^|[\s;&|])exit\s+[1-9]/m.test(run)) v.push("ci-gate: run never exits nonzero (gate cannot fail)");
  const reaches = (name, seen = new Set()) => name === "ci-gate" ? true : (!jobs[name] || seen.has(name)) ? false : (seen.add(name), needsOf(jobs[name]).some((n) => reaches(n, seen)));
  for (const [name, j] of Object.entries(jobs)) {
    if (name === "ci-gate") continue;
    if (!parseable(j.if)) v.push(`${name}: if is unparseable (cannot verify)`);
    if (!reaches(name)) v.push(`${name}: not gated by ci-gate`);
    if (defeatsGating(j.if || "")) v.push(`${name}: if runs after ci-gate is skipped/failed`);
  }
  // every checkout in a release job must not persist credentials — these jobs hold
  // a write-scoped token (packages:write / contents:write) (R19-6).
  for (const [name, j] of Object.entries(jobs))
    (j.steps || []).forEach((s, i) => { if (typeof s.uses === "string" && /actions\/checkout@/.test(s.uses) && String(s.with?.["persist-credentials"]) !== "false") v.push(`${name} step ${i}: checkout persists credentials (set persist-credentials: false)`); });
  // Supply-chain provenance (gemini finding 7): release must PROMOTE the image CI
  // built and tested for this commit, never REBUILD it. A rebuild from a mutable
  // base (Dockerfile.dev `FROM postgres:16-bookworm`) ships bytes CI never saw.
  // So: NO release job may build an image (build-push-action / `docker build`),
  // and the promote must copy the immutable `sha-${{ github.sha }}` staging tag.
  // No release job may BUILD an image — release promotes the digest CI built
  // (dead code stripped so a decoy `docker build` in `while false` doesn't hide).
  for (const [name, j] of Object.entries(jobs)) {
    for (const u of (j.steps || []).map((s) => s.uses).filter((x) => typeof x === "string"))
      if (/docker\/build-push-action/.test(u)) v.push(name + ": builds an image (build-push-action) — release must promote the CI digest, not rebuild");
    if (/docker\s+(?:buildx\s+)?build\b/.test(stripDead((j.steps || []).map((s) => s.run || "").join("\n")))) v.push(name + ": runs 'docker build' — release must promote the CI digest, not rebuild");
  }
  // Each shipped image must be promoted, bound to ITS OWN repo (`REPO=…/pgstack-X`),
  // from the DIGEST of the verified commit's staging tag (`${REPO}@${DIGEST}`) —
  // never a mutable `:sha` tag, a decoy, an unrelated repo, or dead code (finding
  // 3/5). Tying create to the `${REPO}`/`${DIGEST}` the inspect computed binds the
  // source through the shell vars the promote idiom uses.
  // Comments AND dead code stripped, so a decoy `# imagetools inspect …:sha-…` or
  // a signature in `while false` can't satisfy the checks (gemini finding 4, R23).
  const liveR = (j) => stripComments(stripDead((j.steps || []).map((s) => s.run || "").join("\n")));
  for (const img of ["pgstack-proxy", "pgstack-postgres"]) {
    const promoter = Object.entries(jobs).find(([, j]) => {
      const r = liveR(j);
      return new RegExp("REPO=[\"'][^\"'\\n]*" + img + "\\b").test(r) && /imagetools\s+create/.test(r);
    });
    if (!promoter) { v.push("no job promotes " + img + " from its CI-built digest"); continue; }
    const r = liveR(promoter[1]);
    if (!/imagetools\s+inspect/.test(r) || !/:sha-\$\{\{\s*github\.sha\s*\}\}/.test(r))
      v.push(promoter[0] + ": " + img + " promote does not resolve the verified sha-${{ github.sha }} staging tag");
    if (!/imagetools\s+create[\s\S]*\$\{?REPO\}?@\$\{?DIGEST\}?/.test(r))
      v.push(promoter[0] + ": " + img + " imagetools create must use the computed ${REPO}@${DIGEST}, not a tag/unrelated ref");
    // REPO/DIGEST assigned EXACTLY once — catch reassignment via `=`, export,
    // declare, local, readonly, or `printf -v` before the create (finding 5/4).
    const assigns = (name) => (r.match(new RegExp("(?:^|\\n|;)\\s*(?:export\\s+|declare\\s+|local\\s+|readonly\\s+)?" + name + "=", "g")) || []).length + (r.match(new RegExp("printf\\s+-v\\s+" + name + "\\b", "g")) || []).length;
    if (assigns("REPO") !== 1) v.push(promoter[0] + ": " + img + " reassigns REPO before create (ref could be repointed)");
    if (assigns("DIGEST") !== 1) v.push(promoter[0] + ": " + img + " reassigns DIGEST before create (ref could be repointed)");
  }
  // The release version is the git tag: ci-gate must strict-SemVer-validate it AND
  // require sdk+cli package.json to match, and no promote job may carry its own
  // loose `[0-9]*` SemVer case that drifts from ci-gate (gemini findings 2/3).
  const cgRun = (jobs["ci-gate"]?.steps || []).map((s) => s.run || "").join("\n");
  if (!/grep\s+-E\w*\s+'\^\(0\|\[1-9\]/.test(cgRun)) v.push("ci-gate does not strict-SemVer-validate the tag (anchored ^…$ with digit classes)");
  if (!/jq\s+-r\s+\.version\s+sdk\/package\.json/.test(cgRun) || !/jq\s+-r\s+\.version\s+cli\/package\.json/.test(cgRun)) v.push("ci-gate does not require sdk+cli package.json to match the tag version");
  for (const [name, j] of Object.entries(jobs)) if (/case\s+"\$V"\s+in\s+\[0-9\]\*/.test((j.steps || []).map((s) => s.run || "").join("\n"))) v.push(name + ": carries a loose [0-9]* SemVer case (ci-gate owns strict validation)");
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
  const imgPinned = (img) => /@sha256:[0-9a-f]{64}$/.test(img); // container/service image must be digest-pinned
  for (const [jn, job] of Object.entries(jobsOf(wf))) {
    for (const u of [job.uses, ...(job.steps || []).map((s) => s.uses)].filter((x) => typeof x === "string"))
      if (!pinned(u)) v.push(`${jn}: uses '${u}' is not pinned to an immutable ref`);
    // job-level container + service images are mutable refs too (R17-4).
    const cont = typeof job.container === "string" ? job.container : job.container?.image;
    if (typeof cont === "string" && !imgPinned(cont)) v.push(`${jn}: container image '${cont}' is not digest-pinned`);
    for (const [sn, svc] of Object.entries(job.services || {})) {
      const img = typeof svc === "string" ? svc : svc?.image;
      if (typeof img === "string" && !imgPinned(img)) v.push(`${jn}: service '${sn}' image '${img}' is not digest-pinned`);
    }
  }
  return v;
}

// The CI workflow's own hardening must stay in place (gemini R18 closing note):
// read-only default token, checkouts that don't persist credentials, and a
// pinned govulncheck.
function ciPolicy(wf) {
  const v = [];
  const perms = wf.permissions;
  if (perms === undefined) v.push("ci: no top-level permissions (the default token is broad)");
  else if (typeof perms === "string") { if (perms !== "read-all") v.push(`ci: permissions: '${perms}' is not read-only`); }
  else if (typeof perms === "object" && Object.values(perms).some((x) => String(x) === "write")) v.push("ci: a top-level permission is 'write'");
  else if (perms === "write-all") v.push("ci: permissions: write-all");
  // pull_request_target runs untrusted PR code with a write token + secrets (R19-4).
  if ((wf.on || {})["pull_request_target"] !== undefined) v.push("ci: pull_request_target trigger (runs PR code with a write token + secrets)");
  for (const [jn, job] of Object.entries(jobsOf(wf))) {
    (job.steps || []).forEach((s, i) => {
      if (typeof s.uses === "string" && /actions\/checkout@/.test(s.uses) && String(s.with?.["persist-credentials"]) !== "false")
        v.push(`ci: ${jn} step ${i} checkout does not set persist-credentials: false`);
    });
    // A PR-reachable job must never grant itself a write token, nor run on the
    // self-hosted runner (R19-6/R20-6). Push-only-gated publish jobs are exempt —
    // they never execute untrusted PR code (finding 7).
    if (runsOnPR(job)) {
      if (job.permissions === "write-all") v.push(`ci: ${jn} permissions: write-all`);
      else if (job.permissions && typeof job.permissions === "object" && Object.values(job.permissions).some((x) => String(x) === "write")) v.push(`ci: ${jn} has a job-level write permission`);
      // Not a word search (an expression that ROUTES pull_request *to* self-hosted
      // also contains the word "pull_request"): the branch selected when
      // event_name=='pull_request' must be the hosted (ubuntu) runner. Resolve a
      // matrix-provided runner (`runs-on: ${{ matrix.runner }}` +
      // `strategy.matrix.runner: [self-hosted]`) so the label isn't hidden in the
      // matrix (gemini finding 6).
      let ro = JSON.stringify(job["runs-on"] ?? "");
      const mm = ro.match(/matrix\.(\w+)/);
      if (mm) {
        const key = mm[1], m = job.strategy?.matrix, vals = [];
        if (m) { if (m[key] !== undefined) vals.push(m[key]); for (const inc of (m.include || [])) if (inc && inc[key] !== undefined) vals.push(inc[key]); }
        if (vals.length) ro += " " + JSON.stringify(vals);
      }
      if (/self-hosted/.test(ro)) {
        const m = ro.match(/==\s*'pull_request'\s*\)?\s*&&\s*([^|]*?)\s*\|\|/);
        if (!m || !/ubuntu/.test(m[1]) || /self-hosted/.test(m[1])) v.push(`ci: ${jn} runs-on does not route pull_request to an ephemeral hosted runner`);
      }
    }
  }
  const allRun = Object.values(jobsOf(wf)).flatMap((j) => (j.steps || []).map((s) => s.run || "")).join("\n");
  if (/govulncheck@latest\b/.test(allRun)) v.push("ci: govulncheck installed @latest (must be a pinned version)");
  return v;
}

// The CI release-candidate publisher must build BOTH images from their OWN
// Dockerfile, smoke each EXACT digest with the right assertion, create sha-<sha>
// only from a smoked digest (never tag it in the build), and be gated on the FULL
// suite — so a candidate can't be half-built, un-smoked, mis-Dockerfiled, or
// under-gated (gemini finding 4).
function candidatePolicy(wf) {
  const v = [];
  const jobs = jobsOf(wf);
  const cand = Object.entries(jobs).find(([, j]) => (j.steps || []).some((s) => typeof s.uses === "string" && /docker\/build-push-action/.test(s.uses)));
  if (!cand) { v.push("no release-candidate publisher (build-push-action) in CI"); return v; }
  const [cn, cj] = cand;
  const steps = cj.steps || [];
  const builds = steps.filter((s) => typeof s.uses === "string" && /docker\/build-push-action/.test(s.uses));
  // The candidate runs UNTRUSTED-adjacent publish creds, so it must fire ONLY on a
  // trusted master push — not any push branch (gemini finding 4, R23).
  const cif = stripBraces(String(cj.if || ""));
  if (!/event_name\s*==\s*'push'/.test(cif) || !/ref\s*==\s*'refs\/heads\/master'/.test(cif)) v.push(cn + ": candidate job is not gated to push on refs/heads/master");
  const FULL_SUITE = ["test-extension", "test-proxy-go", "test-sdk", "test-cli", "test-security", "test-prod-validator", "test-e2e", "test-integration", "test-async-bgworker", "security"];
  const nd = needsOf(cj);
  for (const g of FULL_SUITE) if (!nd.includes(g)) v.push(cn + ": candidate is not gated on '" + g + "'");
  const IMAGES = [{ img: "pgstack-proxy", file: "./proxy-go/Dockerfile" }, { img: "pgstack-postgres", file: "./Dockerfile.dev" }];
  for (const { img, file } of IMAGES) {
    const b = builds.find((s) => String(s.with?.file) === file);
    if (!b) { v.push(cn + ": no build of " + img + " from " + file); continue; }
    if (String(b.with?.push) !== "true") v.push(cn + ": " + img + " build does not push");
  }
  for (const s of builds) if (/:sha-\$\{\{\s*github\.sha\s*\}\}/.test(String(s.with?.tags ?? ""))) v.push(cn + ": a build tags :sha-${{ github.sha }} directly (must be tagged only AFTER smoke)");
  // Strip comments + dead code so a smoke/promote SIGNATURE in a comment or an
  // unreachable block can't satisfy the structural checks (gemini finding 4, R23).
  const live = (s) => stripComments(stripDead(String(s || "")));
  const run = live(steps.map((s) => s.run || "").join("\n"));
  for (const { img } of IMAGES)
    if (!new RegExp("imagetools\\s+create[^\\n]*" + img + ":sha-\\$\\{\\{\\s*github\\.sha\\s*\\}\\}[^\\n]*" + img + "@\\$\\{\\{\\s*steps\\.").test(run))
      v.push(cn + ": " + img + ":sha-${{ github.sha }} is not created from a built @digest after smoke");
  if (!/pgstack-postgres@\$\{\{\s*steps\.\w+\.outputs\.digest/.test(run) || !/CREATE EXTENSION[\s\S]*pg_reactive/.test(run))
    v.push(cn + ": missing pgstack-postgres digest smoke (boot + CREATE EXTENSION pg_reactive)");
  if (!/pgstack-proxy@\$\{\{\s*steps\.\w+\.outputs\.digest/.test(run) || !/JWT_SECRET still contains 'dev-only'/.test(run))
    v.push(cn + ": missing pgstack-proxy digest smoke (production validator: JWT_SECRET rejection)");
  // sha-<sha> (what release resolves) must be created AFTER both smokes pass — a
  // create-before-smoke would re-expose finding 1 (gemini finding 4, R23).
  const idxOf = (re) => steps.findIndex((s) => re.test(live(s.run || "")));
  const tagIdx = idxOf(/imagetools\s+create[^\n]*:sha-\$\{\{\s*github\.sha/);
  const pgSmoke = idxOf(/CREATE EXTENSION[\s\S]*pg_reactive/);
  const pxSmoke = idxOf(/JWT_SECRET still contains 'dev-only'/);
  if (tagIdx >= 0 && (pgSmoke < 0 || pxSmoke < 0 || tagIdx < pgSmoke || tagIdx < pxSmoke)) v.push(cn + ": sha-${{ github.sha }} is created before the smokes pass (tag-after-smoke order)");
  return v;
}

const deploy = load("deploy.yml");
const release = load("release.yml");
const ci = load("ci.yml");

console.log("=== CI/CD supply-chain gating (FR-B.11.3) ===");
console.log("-- real workflows must be clean --");
const dV = deployPolicy(deploy), rV = releasePolicy(release), cV = ciPolicy(ci), candV = candidatePolicy(ci);
check(dV.length === 0, `deploy policy clean${dV.length ? " — " + dV.join("; ") : ""}`);
check(rV.length === 0, `release policy clean${rV.length ? " — " + rV.join("; ") : ""}`);
check(cV.length === 0, `ci hardening clean${cV.length ? " — " + cV.join("; ") : ""}`);
check(candV.length === 0, `ci candidate publisher clean${candV.length ? " — " + candV.join("; ") : ""}`);
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
// The deploy job's first step is now the CI-verify gate; the SSH deploy step is
// found by its action, so mutations target the right step regardless of order.
const sshStep = (w) => w.jobs.deploy.steps.find((s) => typeof s.uses === "string" && /ssh-action/.test(s.uses));
const DGATE = "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'master')";
mut("deploy if drops event==push", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'master'"; }, deployPolicy);
mut("deploy if true || conds", deploy, (w) => { w.jobs.deploy.if = "true || (" + DGATE + ")"; }, deployPolicy);
mut("deploy if allows master||main", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || github.event.workflow_run.head_branch == 'main')"; }, deployPolicy);
mut("deploy downstream if: always()", deploy, (w) => { w.jobs["deploy-polyglot"].if = "always()"; }, deployPolicy);
mut("deploy if unparseable syntax", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion =~ /success/"; }, deployPolicy);
mut("deploy DEPLOY_SHA wrong order", deploy, (w) => { sshStep(w).env.DEPLOY_SHA = "${{ github.sha || github.event.workflow_run.head_sha }}"; }, deployPolicy);
mut("deploy decoy job-env + step-env github.sha", deploy, (w) => { w.jobs.deploy.env = { DEPLOY_SHA: "${{ github.event.workflow_run.head_sha }}" }; sshStep(w).env.DEPLOY_SHA = "${{ github.sha }}"; }, deployPolicy);
mut("deploy job continue-on-error", deploy, (w) => { w.jobs.deploy["continue-on-error"] = true; }, deployPolicy);
mut("deploy step continue-on-error", deploy, (w) => { sshStep(w)["continue-on-error"] = true; }, deployPolicy);
mut("release ci-gate job continue-on-error", release, (w) => { w.jobs["ci-gate"]["continue-on-error"] = true; }, releasePolicy);
mut("release ci-gate STEP continue-on-error", release, (w) => { w.jobs["ci-gate"].steps[0]["continue-on-error"] = true; }, releasePolicy);
mut("release weaken jq + decoy echo", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/actions/workflows/ci.yml/runs?head_sha=y' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')\necho conclusion==\"success\" event==\"push\" head_branch==\"master\"\nif [ \"$n\" -lt 1 ]; then exit 1; fi"; }, releasePolicy);
mut("release publisher if: always()", release, (w) => { w.jobs["docker-proxy"].if = "always()"; }, releasePolicy);
mut("release publisher drops needs", release, (w) => { delete w.jobs["docker-proxy"].needs; }, releasePolicy);
mut("pin step uses @mutable tag", deploy, (w) => { sshStep(w).uses = "appleboy/ssh-action@v1"; }, pinPolicy);
mut("pin job-level uses @main", release, (w) => { w.jobs.evil = { uses: "attacker/wf@main" }; }, pinPolicy);
mut("pin docker://image:latest", release, (w) => { w.jobs["ci-gate"].steps.push({ uses: "docker://alpine:latest" }); }, pinPolicy);
// R17
mut("deploy if uses unknown fn fromJSON('true')", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || fromJSON('true'))"; }, deployPolicy);
mut("release coe via ${{ true }} expression", release, (w) => { w.jobs["ci-gate"].steps[0]["continue-on-error"] = "${{ true }}"; }, releasePolicy);
mut("release removes real exit, echoes 'exit 1'", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/runs?event=push&branch=master' --jq '[.workflow_runs[] | select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")] | length')\necho 'exit 1'"; }, releasePolicy);
mut("deploy ssh script deploys github.sha directly", deploy, (w) => { sshStep(w).with.script = "git reset --hard ${{ github.sha }}"; }, deployPolicy);
mut("pin job container :latest", release, (w) => { w.jobs["ci-gate"].container = "alpine:latest"; }, pinPolicy);
mut("pin service image :latest", release, (w) => { w.jobs["ci-gate"].services = { db: { image: "postgres:latest" } }; }, pinPolicy);
// R18
mut("release gh api drops head_sha (any green master CI)", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/runs?status=completed&event=push&branch=master' --jq '[.workflow_runs[] | select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")] | length')\nif [ \"$n\" -lt 1 ]; then exit 1; fi"; }, releasePolicy);
mut("deploy git-resets to a branch, $DEPLOY_SHA only in echo", deploy, (w) => { sshStep(w).with.script = "git fetch origin master\ngit reset --hard master\necho deploying $DEPLOY_SHA"; }, deployPolicy);
mut("deploy if allows master||release", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || github.event.workflow_run.head_branch == 'release')"; }, deployPolicy);
mut("release coe via event-context expr", release, (w) => { w.jobs["ci-gate"].steps[0]["continue-on-error"] = "${{ github.event_name == 'push' }}"; }, releasePolicy);
mut("release decoy true/false no-op commands", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/runs?head_sha=z' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')\ntrue --jq 'select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")' '?event=push&branch=master&head_sha=${{ github.sha }}'\nfalse && exit 1"; }, releasePolicy);
mut("deploy listens to Smoke not CI", deploy, (w) => { w.on.workflow_run.workflows = ["Smoke"]; }, deployPolicy);
mut("deploy types: [requested] not completed", deploy, (w) => { w.on.workflow_run.types = ["requested"]; }, deployPolicy);
mut("release adds workflow_dispatch trigger", release, (w) => { w.on.workflow_dispatch = {}; }, releasePolicy);
mut("ci checkout persist-credentials: true", ci, (w) => { const j = Object.values(w.jobs)[0]; const cs = (j.steps || []).find((s) => typeof s.uses === "string" && /actions\/checkout@/.test(s.uses)); cs.with = { ...(cs.with || {}), "persist-credentials": true }; }, ciPolicy);
mut("ci permissions: write-all", ci, (w) => { w.permissions = "write-all"; }, ciPolicy);
mut("ci govulncheck@latest", ci, (w) => { const j = Object.values(w.jobs).find((x) => (x.steps || []).some((s) => /govulncheck/.test(s.run || ""))); const s = j.steps.find((st) => /govulncheck/.test(st.run || "")); s.run = s.run.replace(/govulncheck@v[\d.]+/, "govulncheck@latest"); }, ciPolicy);
// R19
mut("deploy adds schedule trigger (fires without CI)", deploy, (w) => { w.on.schedule = [{ cron: "0 0 * * *" }]; }, deployPolicy);
mut("deploy if head_branch != decoy (allows any branch)", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch != 'nonexistent'"; }, deployPolicy);
mut("deploy if head_branch compared to itself", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.workflow_run.head_branch"; }, deployPolicy);
mut("deploy git-resets to $DEPLOY_SHA^ (parent commit)", deploy, (w) => { sshStep(w).with.script = "git fetch origin\ngit reset --hard \"$DEPLOY_SHA^\""; }, deployPolicy);
mut("release hides head_sha/jq/exit in a heredoc to /dev/null", release, (w) => { w.jobs["ci-gate"].steps[0].run = "n=$(gh api 'repos/x/runs?head_sha=z' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')\ncat <<EOF >/dev/null\nevent=push&branch=master&head_sha=${{ github.sha }}\n--jq 'select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")'\nexit 1\nEOF"; }, releasePolicy);
mut("release push.branches alongside tags", release, (w) => { w.on.push.branches = ["**"]; }, releasePolicy);
mut("release tag pattern bare * (any tag)", release, (w) => { w.on.push.tags = ["*"]; }, releasePolicy);
mut("release checkout persists credentials", release, (w) => { for (const j of Object.values(w.jobs)) { const cs = (j.steps || []).find((s) => typeof s.uses === "string" && /actions\/checkout@/.test(s.uses)); if (cs) { cs.with = { ...(cs.with || {}), "persist-credentials": true }; return; } } }, releasePolicy);
mut("ci adds pull_request_target trigger", ci, (w) => { w.on.pull_request_target = {}; }, ciPolicy);
mut("ci job runs on unconditional self-hosted", ci, (w) => { Object.values(w.jobs)[0]["runs-on"] = ["self-hosted", "Linux", "X64"]; }, ciPolicy);
mut("ci job grants itself contents: write", ci, (w) => { Object.values(w.jobs)[0].permissions = { contents: "write" }; }, ciPolicy);
// R20
mut("deploy if || workflow_run.id (unmodeled truthy field)", deploy, (w) => { w.jobs.deploy.if = DGATE + " || github.event.workflow_run.id"; }, deployPolicy);
mut("deploy reset to \"${DEPLOY_SHA}^\" (parent via braces)", deploy, (w) => { sshStep(w).with.script = "git fetch origin\ngit reset --hard \"${DEPLOY_SHA}^\""; }, deployPolicy);
mut("deploy reset to \"$DEPLOY_SHA\"~1 (parent past quote)", deploy, (w) => { sshStep(w).with.script = "git fetch origin\ngit reset --hard \"$DEPLOY_SHA\"~1"; }, deployPolicy);
mut("deploy good reset + extra reset to master", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"\ngit reset --hard master"; }, deployPolicy);
mut("deploy good reset in uncalled fn, master reset live", deploy, (w) => { sshStep(w).with.script = "deployfn() {\n  git reset --hard \"$DEPLOY_SHA\"\n}\ngit reset --hard master"; }, deployPolicy);
mut("deploy downstream job resets master", deploy, (w) => { w.jobs.evil = { needs: "deploy", "runs-on": ["self-hosted"], steps: [{ uses: "appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2", with: { script: "git reset --hard master" } }] }; }, deployPolicy);
mut("release strong gate hidden in uncalled fn, real gh api weak", release, (w) => { w.jobs["ci-gate"].steps[0].run = "check() {\ngh api 'repos/x/runs?event=push&branch=master&head_sha=${{ github.sha }}' --jq '[.workflow_runs[] | select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")] | length'\nexit 1\n}\nn=$(gh api 'repos/x/runs?head_sha=z' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')"; }, releasePolicy);
mut("release strong gate hidden in if [ 1 -eq 0 ]", release, (w) => { w.jobs["ci-gate"].steps[0].run = "if [ 1 -eq 0 ]; then\ngh api 'repos/x/runs?event=push&branch=master&head_sha=${{ github.sha }}' --jq '[.workflow_runs[] | select(.conclusion==\"success\" and .event==\"push\" and .head_branch==\"master\")] | length'\nexit 1\nfi\nn=$(gh api 'repos/x/runs?head_sha=z' --jq '[.workflow_runs[] | select(.conclusion==\"success\")] | length')"; }, releasePolicy);
mut("ci runs-on routes pull_request to self-hosted (inverted)", ci, (w) => { Object.values(w.jobs)[0]["runs-on"] = "${{ (github.event_name == 'pull_request') && fromJSON('[\"self-hosted\", \"Linux\", \"X64\"]') || fromJSON('[\"ubuntu-latest\"]') }}"; }, ciPolicy);
// finding 7 — release must PROMOTE the CI-built digest, never REBUILD
mut("release rebuilds via build-push-action", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "Build", uses: "docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25", with: { file: "./proxy-go/Dockerfile", push: true } }); }, releasePolicy);
mut("release runs docker build", release, (w) => { w.jobs["docker-postgres"].steps.push({ name: "Build", run: "docker buildx build -t x ." }); }, releasePolicy);
mut("release promote source is mutable :latest not sha", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/sha-\$\{\{\s*github\.sha\s*\}\}/, "latest"); }, releasePolicy);
mut("release drops the digest promote", release, (w) => { for (const jn of ["docker-proxy", "docker-postgres"]) w.jobs[jn].steps = w.jobs[jn].steps.filter((st) => !/imagetools/.test(st.run || "")); }, releasePolicy);
// finding 3 — each image promoted from its OWN repo's computed digest
mut("release drops postgres promotion (proxy still promotes)", release, (w) => { const j = w.jobs["docker-postgres"]; j.steps = j.steps.filter((st) => !/imagetools/.test(st.run || "")); }, releasePolicy);
mut("release promotes the proxy repo inside the postgres job", release, (w) => { const s = w.jobs["docker-postgres"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/pgstack-postgres/g, "pgstack-proxy"); }, releasePolicy);
mut("release creates from the mutable :sha tag, not the digest", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/\$\{REPO\}@\$\{DIGEST\}/, "${REPO}:sha-${{ github.sha }}"); }, releasePolicy);
// finding 5 — a promote buried in dead code doesn't count
mut("release promote buried in while false", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = "while false; do\n" + s.run + "\ndone"; }, releasePolicy);
// finding 4 — the CI release-candidate publisher is policed
mut("ci candidate proxy build push: false", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => String(st.with?.file) === "./proxy-go/Dockerfile"); s.with.push = false; }, candidatePolicy);
mut("ci candidate drops the postgres build", ci, (w) => { const j = w.jobs["build-publish-images"]; j.steps = j.steps.filter((st) => String(st.with?.file) !== "./Dockerfile.dev"); }, candidatePolicy);
mut("ci candidate builds postgres tag from the proxy Dockerfile", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => String(st.with?.file) === "./Dockerfile.dev"); s.with.file = "./proxy-go/Dockerfile"; }, candidatePolicy);
mut("ci candidate removes both smoke tests", ci, (w) => { const j = w.jobs["build-publish-images"]; j.steps = j.steps.filter((st) => !/CREATE EXTENSION|JWT_SECRET still contains/.test(st.run || "")); }, candidatePolicy);
mut("ci candidate proxy smoke replaced with exit 42", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => /JWT_SECRET still contains/.test(st.run || "")); s.run = "exit 42"; }, candidatePolicy);
mut("ci candidate drops six suite gates", ci, (w) => { w.jobs["build-publish-images"].needs = ["test-proxy-go", "test-e2e", "test-security", "test-prod-validator"]; }, candidatePolicy);
mut("ci candidate drops all needs", ci, (w) => { delete w.jobs["build-publish-images"].needs; }, candidatePolicy);
// finding 6 — matrix-provided self-hosted runner on a PR-reachable job
mut("ci PR job routes to self-hosted via matrix", ci, (w) => { const j = Object.values(w.jobs)[0]; j.strategy = { matrix: { runner: ["self-hosted"] } }; j["runs-on"] = "${{ matrix.runner }}"; }, ciPolicy);
// finding 7 — git switch to a moving branch after the verified reset
mut("deploy git switch master after verified reset", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"\ngit switch master"; }, deployPolicy);
// R22 finding 3 — manual deploy must be pinned to refs/heads/master
mut("deploy allows workflow_dispatch on any ref", deploy, (w) => { w.jobs.deploy.if = "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'master')"; }, deployPolicy);
// R22 finding 5 — text-analyzer hardening
mut("deploy git -C . switch master after reset", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"\ngit -C . switch master"; }, deployPolicy);
mut("ci PR job self-hosted via matrix.include", ci, (w) => { const j = Object.values(w.jobs)[0]; j.strategy = { matrix: { include: [{ runner: "self-hosted" }] } }; j["runs-on"] = "${{ matrix.runner }}"; }, ciPolicy);
mut("release reassigns REPO before imagetools create", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/(docker buildx imagetools create)/, "REPO=evil\n          $1"); }, releasePolicy);
// R23 finding 1 — manual deploy must verify green CI for github.sha
mut("deploy removes the workflow_dispatch CI-green gate", deploy, (w) => { w.jobs.deploy.steps = w.jobs.deploy.steps.filter((s) => !/gh\s+api/.test(s.run || "")); }, deployPolicy);
// R23 finding 4 — candidate/release structural bypasses
mut("ci candidate creates sha-* BEFORE smoke", ci, (w) => { const st = w.jobs["build-publish-images"].steps; const ti = st.findIndex((s) => /imagetools create[^\n]*:sha-/.test(s.run || "")); const tag = st.splice(ti, 1)[0]; const bi = st.findIndex((s) => /build-push/.test(s.uses || "")); st.splice(bi + 1, 0, tag); }, candidatePolicy);
mut("ci candidate proxy smoke signature only in a comment", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => /JWT_SECRET still contains/.test(st.run || "")); s.run = "# JWT_SECRET still contains 'dev-only' (decoy)\necho ok"; }, candidatePolicy);
mut("ci candidate runs on any push branch", ci, (w) => { w.jobs["build-publish-images"].if = "github.event_name == 'push'"; }, candidatePolicy);
mut("release inspect signature only in a comment", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/^\s*DIGEST=.*/m, "          # docker buildx imagetools inspect \"$SRC\" :sha-${{ github.sha }} decoy\n          DIGEST=sha256:decoy"); }, releasePolicy);
mut("release reassigns DIGEST via export", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/(docker buildx imagetools create)/, "export DIGEST=sha256:evil\n          $1"); }, releasePolicy);
mut("release reassigns DIGEST via printf -v", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = s.run.replace(/(docker buildx imagetools create)/, "printf -v DIGEST sha256:evil\n          $1"); }, releasePolicy);
// R23 findings 2/3 — the version is the git tag, validated once in ci-gate
mut("release ci-gate drops strict SemVer validation", release, (w) => { const s = w.jobs["ci-gate"].steps.find((st) => /grep -E/.test(st.run || "")); s.run = s.run.replace(/grep -Eq '[^']*'/, "grep -q ."); }, releasePolicy);
mut("release ci-gate drops the cli version match", release, (w) => { const s = w.jobs["ci-gate"].steps.find((st) => /cli\/package\.json/.test(st.run || "")); s.run = s.run.replace(/.*cli\/package\.json.*\n?/, ""); }, releasePolicy);
mut("release promote re-adds a loose [0-9]* SemVer case", release, (w) => { const s = w.jobs["docker-proxy"].steps.find((st) => /imagetools create/.test(st.run || "")); s.run = 'case "$V" in [0-9]*.[0-9]*.[0-9]*) ;; esac\n' + s.run; }, releasePolicy);

if (fail) {
  console.error(`\nFAIL: ${fail} — CI/CD supply-chain gating regressed or the guard missed a known mutation.`);
  process.exit(1);
}
console.log("\nPASS: policy clean on real workflows; all known bypass mutations caught.");
