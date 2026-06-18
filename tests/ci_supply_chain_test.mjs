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
import { readFileSync, existsSync } from "node:fs";
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
// Remove short-circuit-dead tails: `true || X` / `false && X` never run X — so a
// `true || grep "JWT_SECRET…"` can't fake a smoke assertion by mere presence of the
// string. Only literal true/false on the left (a real `grep … || {err}` is kept).
const stripDeadBranches = (s) => s.replace(/\btrue\s*\|\|[^\n;&|]*/g, " ").replace(/\bfalse\s*&&[^\n;&|]*/g, " ");
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
// "Should-run" contexts for critical steps, + a detector for a step that is
// SILENTLY DISABLED (so its content passes the structural check but it never
// runs / always succeeds): if: false, an early `exit 0` short-circuit, or
// continue-on-error (gemini R25-1).
const PUSH_TAG = { github: { event_name: "push", ref: "refs/tags/v9.9.9", sha: "TAGSHA" }, __funcs: { always: true, success: true, failure: false, cancelled: false } };
const PUSH_MASTER = { github: { event_name: "push", ref: "refs/heads/master", sha: "MASTERSHA" }, __funcs: { always: true, success: true, failure: false, cancelled: false } };
const gateDisabled = (s, ctx) => {
  const r = [];
  try { if (!truthy(ev(String(s.if || "true"), ctx))) r.push("if never fires"); } catch { r.push("if unparseable"); }
  // Any early SUCCESS exit short-circuits the real check: `exit 0`, a bare `exit`
  // (inherits the last status — `true; exit` is 0), or `exit $?`. A real gate only
  // ever `exit`s NON-zero, conditionally (gemini R26-1). `exit 1` is fine.
  if (/(?:^|[\n;&|]|\bthen\b|\bdo\b)\s*exit(?:\s+(?:0+|\$\?))?\s*(?:$|[\n;&|])/m.test(stripComments(String(s.run || "")))) r.push("early success `exit` (exit / exit 0 / exit $?) short-circuits the check");
  if (coeStep(s)) r.push("continue-on-error");
  return r;
};
const defeatsGating = (s) => { if (!s || !hasStatusFn(s)) return false; try { return truthy(ev(s, FAIL_CTX)); } catch { return true; } };
// R27 architecture: the critical gate/validation/smoke LOGIC lives in
// .github/scripts/*.sh, tested by EXECUTION in tests/release_scripts_test.mjs —
// regex-analysis of inline workflow shell had hit its limit. The guard's job
// shrinks to: the right step CALLS the right script, with a REAL shell, and isn't
// silently disabled. `{0}`-style fake shells (`shell: true {0}`), `if: false`,
// and continue-on-error are the workflow-level disables that still need catching.
const REAL_SHELL = /^(bash|sh|pwsh|powershell|python|python3|cmd)\b/;
// Join shell line-continuations FIRST (`\` + newline + leading indent → a space)
// so a command split across lines (`docker buildx imagetools \⏎ create …`,
// `npm dist-tag \⏎ add …`) is matched as the single logical command it runs as,
// not bypassed by the line break (gemini R35).
const joinCont = (s) => String(s ?? "").replace(/\\\r?\n[ \t]*/g, " ");
// LIVE run text: line-continuations joined, then `#` comments, short-circuit-dead
// tails (`true || …`), AND unreachable blocks (`if false; then …; fi` /
// `while false` / uncalled functions / heredocs) all stripped — so a script call
// that never runs doesn't count as a call (gemini R28-3 / R29 / R30 / R35).
const lr = (s) => stripDeadBranches(stripComments(stripDead(joinCont(s))));
// Shell-aware tokenization: split LIVE text into simple commands on UNQUOTED
// separators (; | & newline ( )), then each into an argv list with the QUOTING
// REMOVED exactly as Bash word-splitting does, so a command name split across
// quoting/escaping collapses to one argv token and is matched as the command it
// runs as, not the file bytes (gemini R36/R37). Reproduced forms:
//   image"tools" / image'tools'        ordinary quotes  -> imagetools
//   image$'tools' / image$"tools"      ANSI-C / locale  -> imagetools  (R37)
//   imageto\ols / a\dd                 backslash escape -> imagetools  (R37)
// while "imagetools create" stays ONE token (an echo arg, NOT the command
// `imagetools` then `create`) — so no false positive. Nested $()/quotes aren't
// fully parsed, but no real workflow run yields a spurious imagetools-create /
// npm-dist-tag-add token sequence, and over-tokenization can only over-match.
const shellCommands = (text) => {
  const s = String(text ?? "");
  const cmds = []; let argv = [], cur = "", inTok = false;
  const endTok = () => { if (inTok) { argv.push(cur); cur = ""; inTok = false; } };
  const endCmd = () => { endTok(); if (argv.length) cmds.push(argv); argv = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    // $'…' (ANSI-C) / $"…" (locale): drop the `$`+quote, concatenate the content
    // into the SAME word; inside $'…' a backslash escapes the next char.
    if (c === "$" && (n === "'" || n === '"')) {
      const close = n; inTok = true; i += 2;
      for (; i < s.length && s[i] !== close; i++) { if (close === "'" && s[i] === "\\" && i + 1 < s.length) i++; cur += s[i]; }
      continue;
    }
    // $(…) command substitution / `…` backticks: consume as a BALANCED unit kept
    // raw in the token (inner quotes/parens don't split it) — the token is then
    // "dynamic" (isDyn) and matched as a wildcard in command positions (R38).
    if (c === "$" && n === "(") {
      inTok = true; let depth = 0, qq = null, j = i;
      for (; j < s.length; j++) { const d = s[j]; cur += d; if (qq) { if (d === qq) qq = null; continue; } if (d === "'" || d === '"') { qq = d; continue; } if (d === "(") depth++; else if (d === ")" && --depth === 0) { j++; break; } }
      i = j - 1; continue;
    }
    if (c === "`") { inTok = true; cur += c; i++; for (; i < s.length && s[i] !== "`"; i++) cur += s[i]; if (i < s.length) cur += "`"; continue; }
    if (c === "'") { inTok = true; i++; for (; i < s.length && s[i] !== "'"; i++) cur += s[i]; continue; }
    if (c === '"') { inTok = true; i++; for (; i < s.length && s[i] !== '"'; i++) { if (s[i] === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) i++; cur += s[i]; } continue; }
    if (c === "\\" && i + 1 < s.length) { cur += n; i++; inTok = true; continue; } // unquoted backslash escapes the next char
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")") { endCmd(); continue; }
    if (/\s/.test(c)) { endTok(); continue; }
    cur += c; inTok = true;
  }
  endCmd();
  return cmds;
};
// A token whose value is resolved at RUNTIME — command substitution `$(…)` /
// backtick (R38), OR parameter expansion `$VAR` / `${VAR}` (R39) — can't be known
// statically, so in a command/sub-verb position it matches the forbidden sequence
// as a WILDCARD (fail closed): `"$(printf imagetools)" create` and
// `SUB=imagetools; … "$SUB" create` are both treated as `imagetools create`.
const isDyn = (t) => typeof t === "string" && (/\$[({\w]/.test(t) || t.includes("`"));
// Transparent leading tokens that don't change WHICH command runs — so the
// forbidden VERB sequence may legitimately start right after them. `docker`/`buildx`
// front the imagetools verbs; `npm` fronts the dist-tag verbs (so the npm seq is
// ["dist-tag","add"], not ["npm",…]). Anything else in front (e.g. `bash
// promote-image.sh`) means the dynamic tokens are ARGUMENTS, not the command, and
// must NOT wildcard-match (else the real promote, full of ${{ … }} args, would
// false-positive) — gemini R39/R40.
const LAUNCHER = new Set(["docker", "buildx", "npm", "sudo", "command", "env", "exec", "time", "nice", "nohup", "stdbuf"]);
// A token is a transparent command-head lead if it's a launcher, a VAR= assignment,
// a CLI option (-x / --flag / --flag=val), or the value of the preceding non-`=`
// option — so `docker --context default buildx imagetools create` and `npm --prefix
// sdk dist-tag add` still anchor to the verb sequence (gemini R40).
const transparentLead = (argv, j) => {
  let prevOpt = false;
  for (let p = 0; p < j; p++) {
    const t = argv[p];
    if (LAUNCHER.has(t) || /^\w+=/.test(t)) { prevOpt = false; continue; }
    if (/^-/.test(t)) { prevOpt = !t.includes("="); continue; } // option; expects a value unless --x=y
    if (prevOpt) { prevOpt = false; continue; }                 // value of the previous option
    return false;                                               // a bare positional word → not the command head
  }
  return true;
};
// Does `seq` (the command's sub-verbs) start at a COMMAND HEAD in argv — index 0,
// or after only transparent leads (launchers / assignments / options+values)? A
// dynamic token then wildcard-matches the expected element; a dynamic ARGUMENT
// (past the head, behind a non-launcher command) never does.
const seqIn = (argv, seq) => argv.some((_, j) => {
  if (!transparentLead(argv, j)) return false;
  // match the verbs in order from the command head, skipping CLI options (+ their
  // values) BETWEEN verbs too — `npm dist-tag --registry=URL add` still matches
  // ["dist-tag","add"] (gemini R41-2).
  let i = j, prevOpt = false;
  for (const t of seq) {
    while (i < argv.length) { const x = argv[i]; if (/^-/.test(x)) { prevOpt = !x.includes("="); i++; continue; } if (prevOpt) { prevOpt = false; i++; continue; } break; }
    const x = argv[i];
    if (x === undefined || !(x === t || isDyn(x))) return false;
    i++; prevOpt = false;
  }
  return true;
});
// Does any simple command in `text` invoke `seq` (e.g. ["imagetools","create"] /
// ["npm","dist-tag","add"])? Pass lr(text) so dead/commented/continued forms are
// already normalized.
const runsCmd = (text, seq) => shellCommands(text).some((argv) => seqIn(argv, seq));
// The effective command head: the first token that isn't a `VAR=val` assignment.
const effHead = (argv) => { let i = 0; while (i < argv.length && /^\w+=/.test(argv[i])) i++; return argv[i]; };
// Shell no-ops with no registry/filesystem-mutating effect — allowed anywhere a
// write-scoped job is held to an ALLOWLIST (R42).
const NOOP_HEAD = new Set(["echo", "printf", ":", "true", "false", "set", "export", "cd"]);
// True for a command head with no registry/filesystem-mutating effect: a no-op
// word, an empty command, or a redirection artifact the simple-command splitter
// leaves behind (`2>&1` splits on `&` → a bare `1`; a leading `>/dev/null`). A
// real command head is a word, never a number or a redirection token.
const isNoopHead = (h) => h === undefined || NOOP_HEAD.has(h) || /^[0-9]+$/.test(h) || /^[0-9]*[<>]/.test(h);
// A command-SUBSTITUTION token — `$(…)` or a backtick — executes a side command
// BEFORE its host command runs, so even an `echo "$(crane copy …)"` re-points a
// tag despite the no-op head. In a write-scoped job (allowlisted to a tiny
// command set) this is refused fail-closed: no allowlisted command may carry a
// substitution. Parameter expansion (`$VAR`/`${VAR}`/`${{ … }}`) runs no command
// and is NOT flagged, so the real promote/imagetools args stay clean (R43).
const hasCmdSub = (argv) => argv.some((t) => /\$\(/.test(t) || t.includes("`"));
// A heredoc / here-string (`<<`, `<<-`, `<<<`) whose body Bash LIVE-EXPANDS:
// `echo <<EOF`⏎`$(crane copy …)`⏎`EOF` runs the substitution before the host
// command, but `lr`→`stripDead` discards the heredoc body as "dead code", so the
// R43 substitution check never sees it. A write-scoped job has no business with a
// heredoc, so its mere presence in a run step is refused fail-closed (R44).
const hasHeredoc = (run) => /<</.test(joinCont(String(run ?? "")));
// Is `scriptRe` the EFFECTIVE command of argv — the command head, reached after
// only transparent launchers (bash/sh/sudo/env/…), `VAR=` assignments, and
// options — rather than merely an argument sitting somewhere in the line? A
// `bash -c "<cmd>" .github/scripts/x.sh` runs `<cmd>`; the script path then lands
// in $0/$1 and is NEVER executed, so a `-c` in the lead (which makes the next
// token a command STRING, not a script file) means the marker is an argument and
// is refused — the allowlist must match the command SHAPE, not marker presence (R45).
// The same trap exists with GNU `env -S "<cmd>" x.sh` / `--split-string` (R46) and
// `bash -ec`-style clusters: any lead option that turns a value into the command
// to run (`-c`, `-S`, `--split-string`) is refused fail-closed.
const SCRIPT_LEAD = new Set(["bash", "sh", "dash", "ksh", "zsh", ...LAUNCHER]);
const isScriptCommand = (argv, scriptRe) => {
  let i = 0, prevOpt = false;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (prevOpt) { prevOpt = false; continue; }                  // value of a prior non-`=` option
    if (/^-/.test(t)) { if (/^-[A-Za-z]*[cS]/.test(t) || /^--split-string/.test(t)) return false; prevOpt = !t.includes("="); continue; } // -c / -ec / env -S / --split-string: the next arg/value is the command to run
    if (SCRIPT_LEAD.has(t) || /^\w+=/.test(t)) continue;
    break;                                                       // first positional word = the command head
  }
  return i < argv.length && scriptRe.test(argv[i]);
};
const callsScript = (job, script) => (job.steps || []).find((s) => new RegExp("\\.github/scripts/" + script.replace(/\./g, "\\.")).test(lr(s.run)));
const stepDisabled = (s, ctx) => {
  const r = [];
  const sh = String(s.shell || "").trim();
  // a custom shell must be a real interpreter, with no `-c` (`shell: bash -c 'true'
  // {0}` runs `true <scriptfile>`) and no control operator `| ; &` (`shell: bash {0}
  // || true` swallows the script's failure) — gemini R28-3 / R30.
  if (sh && (!REAL_SHELL.test(sh) || /(?:^|\s)-c(?:\s|$)/.test(sh) || /[|;&]/.test(sh))) r.push("custom/fake shell '" + sh + "' may not execute the script ({0}) or swallows its failure");
  try { if (!truthy(ev(String(s.if || "true"), ctx))) r.push("if never fires"); } catch { r.push("if unparseable"); }
  if (/always\s*\(/.test(String(s.if || ""))) r.push("if: always() (runs even after a prior step failed)");
  if (coeStep(s)) r.push("continue-on-error");
  // `bash script.sh || true` / `|| :` / `|| echo …` / `|| exit 0` swallows the
  // script's failure (R28-3 / R31). A fail-CLOSED re-raise (`|| { echo …; exit 1; }`)
  // is left alone. This is the blocklist for the SHARED sites (npm publish, sha-tag);
  // critical .sh gating steps additionally get the bareCall allowlist below.
  if (/\|\|\s*(?:true|:|echo|printf|exit\s+0)\b/.test(stripComments(String(s.run || "")))) r.push("script failure swallowed by `|| true` / `|| :` / `|| echo …` / `|| exit 0`");
  return r;
};
// A CRITICAL gating script (require-green-ci / validate-release-version /
// promote-image / smoke-*) must be invoked as a BARE single command so its
// non-zero exit ALWAYS fails the step. stepDisabled is a blocklist (known swallow
// tails); this is the ALLOWLIST the auditor asked for (R31): reject ANY live shell
// logic around the call — a conditional/loop wrapper (`if ! script; then echo ok;
// fi`), a control operator (`script || echo ok`, `a && script`, `script | cat`,
// `script; echo ok`), a command substitution, or any extra command line. Only the
// bare `… /<script> …` call (plus optional `set -…` shell-option lines) is allowed.
// Dead code is stripped first (lr), so this only sees what actually runs.
const bareCall = (step, script) => {
  const r = [];
  const re = new RegExp("\\.github/scripts/" + script.replace(/\./g, "\\."));
  const lines = lr(step && step.run).split("\n").map((l) => l.trim()).filter(Boolean);
  const callLines = lines.filter((l) => re.test(l));
  const extra = lines.filter((l) => !re.test(l) && !/^set\s+[-+]/.test(l));
  if (extra.length) r.push(script + " is not a bare single-command call — extra shell line(s) " + JSON.stringify(extra));
  for (const l of callLines) {
    if (/^(?:if|elif|while|until|for|case)\b/.test(l) || /^!\s/.test(l)) r.push(script + " call is wrapped in a conditional/loop (its failure is swallowed): " + JSON.stringify(l));
    if (/[|;&]/.test(l) || /\$\(|`/.test(l)) r.push(script + " call has a shell control operator/substitution (its failure may be swallowed): " + JSON.stringify(l));
  }
  return r;
};
// The scripts must EXIST and the offline-executable ones must be covered by the
// execution test (so the behavioral correctness is actually exercised).
const SCRIPTS_DIR = ".github/scripts/";
const SCRIPT_TEST = "tests/release_scripts_test.mjs";
const scriptTestSrc = existsSync(SCRIPT_TEST) ? readFileSync(SCRIPT_TEST, "utf-8") : "";
function scriptsContract() {
  const v = [];
  const all = ["validate-release-version.sh", "require-green-ci.sh", "npm-dist-tag.sh", "compute-docker-tags.sh", "promote-image.sh", "smoke-postgres.sh", "smoke-proxy.sh"];
  for (const s of all) if (!existsSync(SCRIPTS_DIR + s)) v.push("missing gate script .github/scripts/" + s);
  // EVERY script must be exercised by the execution test — the deterministic ones
  // directly, the Docker-bound ones (promote/smoke) via a stubbed docker, so a
  // `exit 0` reimplementation is caught, not merely existence (gemini R28-4).
  for (const s of all) if (!scriptTestSrc.includes(s)) v.push(s + " is not exercised by " + SCRIPT_TEST);
  return v;
}
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
    // The CI-verify gate step legitimately passes github.sha to require-green-ci.sh —
    // exclude it from the deploy-script checks (those guard the git-reset/SSH script).
    const script = stripNoise(stripDead((j.steps || []).filter((s) => !/require-green-ci\.sh/.test(String(s.run || ""))).map((s) => String(s.with?.script ?? s.run ?? "")).join("\n")));
    if (/github\.sha\b/.test(script)) v.push(`${name}: deploy script references github.sha directly`);
    for (const t of resetTargets(script)) { allTargets.push(t); if (!exactSha(t)) v.push(`${name}: git reset/checkout target '${t}' is not exactly $DEPLOY_SHA`); }
  }
  if (!allTargets.length) v.push("no job git-resets/checks out the verified $DEPLOY_SHA");
  // The workflow_run path is CI-gated by the job `if`; a manual workflow_dispatch
  // is NOT, so it must CALL the execution-tested require-green-ci.sh — enabled
  // (real shell, if fires on a master dispatch, not coe) and BEFORE the deploy
  // step (finding 1, R23; logic extracted to a tested script, R27).
  let gateFound = false;
  for (const [jn, j] of Object.entries(jobs)) {
    const st = j.steps || [];
    const gi = st.findIndex((s) => /workflow_dispatch/.test(String(s.if || "")) && /require-green-ci\.sh/.test(lr(s.run)));
    if (gi < 0) continue;
    gateFound = true;
    for (const reason of stepDisabled(st[gi], wd("refs/heads/master"))) v.push(jn + ": workflow_dispatch gate " + reason);
    for (const reason of bareCall(st[gi], "require-green-ci.sh")) v.push(jn + ": workflow_dispatch gate " + reason);
    if (!/\$\{\{\s*github\.sha\s*\}\}/.test(lr(st[gi].run))) v.push(jn + ": workflow_dispatch gate does not pass ${{ github.sha }} to require-green-ci.sh (hardcoded/foreign SHA)");
    const di = st.findIndex((s) => /ssh-action/.test(String(s.uses || "")) || /git(?:\s+-C\s+\S+)?\s+(?:reset|checkout|switch)\b/.test(String(s.with?.script ?? s.run ?? "")));
    if (di >= 0 && gi > di) v.push(jn + ": workflow_dispatch CI-gate runs AFTER the deploy step (too late)");
  }
  if (!gateFound) v.push("no workflow_dispatch CI-green gate (require-green-ci.sh) — a red master commit could be hand-deployed");
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
  // ci-gate's logic now lives in execution-tested scripts (R27): it must CALL
  // require-green-ci.sh (CI-green for the tagged SHA on master) AND
  // validate-release-version.sh (strict SemVer + sdk/cli match) — each via a real
  // shell, with an if that fires on a tag push, and not continue-on-error.
  const gci = callsScript(cg, "require-green-ci.sh");
  if (!gci) v.push("ci-gate does not call require-green-ci.sh");
  else { for (const r of stepDisabled(gci, PUSH_TAG)) v.push("ci-gate require-green-ci step " + r); for (const r of bareCall(gci, "require-green-ci.sh")) v.push("ci-gate require-green-ci step " + r); if (!/\$\{\{\s*github\.sha\s*\}\}/.test(lr(gci.run))) v.push("ci-gate require-green-ci is not passed ${{ github.sha }} (hardcoded/foreign SHA)"); }
  const vrv = callsScript(cg, "validate-release-version.sh");
  if (!vrv) v.push("ci-gate does not call validate-release-version.sh");
  else { for (const r of stepDisabled(vrv, PUSH_TAG)) v.push("ci-gate validate-version step " + r); for (const r of bareCall(vrv, "validate-release-version.sh")) v.push("ci-gate validate-version step " + r); if (!/\$\{\{\s*github\.ref_name\s*\}\}/.test(lr(vrv.run))) v.push("ci-gate validate-version is not passed ${{ github.ref_name }} (validates the wrong tag)"); }
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
    // No release job may run `imagetools create` DIRECTLY: promotion is delegated to
    // promote-image.sh (which sources the CI-built digest). A direct create after a
    // correct promote can re-point a release tag to :latest / a foreign image — an
    // OVERWRITE the promote-presence check alone misses (R34).
    // No release job may run ANY direct docker tag-mutation primitive — imagetools
    // create, manifest create/push, docker tag/push all re-point a tag without
    // promote-image.sh, which the imagetools-only ban missed (gemini R34/R41-1).
    {
      const jr = lr((j.steps || []).map((s) => s.run || "").join("\n"));
      for (const seq of [["imagetools", "create"], ["manifest", "create"], ["manifest", "push"], ["docker", "tag"], ["docker", "push"]])
        if (runsCmd(jr, seq)) { v.push(name + ": runs a direct docker tag-mutation (`" + seq.join(" ") + "`) — release promotion must be delegated to promote-image.sh, not re-pointed in the workflow"); break; }
    }
  }
  // Each shipped image is promoted by a job that CALLS promote-image.sh with ITS
  // OWN repo — the digest-resolution + tag-set logic is in promote-image.sh /
  // compute-docker-tags.sh (the latter execution-tested). The promote step must be
  // enabled (real shell, if fires, not coe) — R27.
  for (const img of ["pgstack-proxy", "pgstack-postgres"]) {
    const imgRe = new RegExp("promote-image\\.sh[^\\n]*" + img + "\\b");
    const promoters = Object.entries(jobs).filter(([, j]) => (j.steps || []).some((s) => imgRe.test(lr(s.run))));
    if (!promoters.length) { v.push("no job promotes " + img + " via promote-image.sh"); continue; }
    // check EVERY step that promotes THIS image (find by img, not the first
    // promote step) — a decoy promote with the right SHA must not excuse a real
    // promote of the same image on a foreign SHA (R32).
    for (const [jn, j] of promoters)
      for (const st of (j.steps || []).filter((s) => imgRe.test(lr(s.run)))) {
        for (const r of stepDisabled(st, PUSH_TAG)) v.push(jn + " (" + img + " promote) " + r);
        for (const r of bareCall(st, "promote-image.sh")) v.push(jn + " (" + img + " promote) " + r);
        if (!/\$\{\{\s*github\.sha\s*\}\}/.test(lr(st.run))) v.push(jn + ": " + img + " promote is not passed ${{ github.sha }} (could promote a foreign commit)");
      }
  }
  // R42: blocklisting the docker CLI tag-mutation primitives (imagetools/manifest/
  // docker tag+push, above) is a losing game — ANY registry client holding the
  // job's GHCR creds (crane/regctl/oras, or a bare curl manifest PUT, even
  // containerized via `docker run …crane copy`) can re-point a tag without the
  // docker CLI. So a registry-write release job (packages:write, or it
  // docker-logs-in to a registry) is held to an ALLOWLIST: every command it runs
  // must be a bare promote-image.sh call (promotion is delegated to the
  // execution-tested script) or a shell no-op. Setup (checkout/buildx/login) is
  // `uses`, not run, so it doesn't appear here. An unknown command head — i.e. any
  // other registry client — is rejected, closing the whole class at once.
  const registryWrite = (j) =>
    (j.permissions && typeof j.permissions === "object" && String(j.permissions.packages) === "write") ||
    (j.steps || []).some((s) => (typeof s.uses === "string" && /docker\/login-action/.test(s.uses)) || /\bdocker\s+login\b/.test(lr(s.run)));
  for (const [name, j] of Object.entries(jobs)) {
    if (!registryWrite(j)) continue;
    for (const s of (j.steps || [])) {
      if (hasHeredoc(s.run)) v.push(name + ": registry-write job uses a heredoc/here-string (<<) — its body live-expands command substitutions the guard can't inspect (only bare promote-image.sh may run; R44)");
      for (const argv of shellCommands(lr(s.run))) {
        if (!argv.length) continue;
        if (hasCmdSub(argv)) { v.push(name + ": registry-write job runs a command carrying a substitution $()/backtick (" + JSON.stringify(argv.join(" ").slice(0, 70)) + ") — the shell runs it as a side command before the host command, re-pointing a tag past the no-op head (R43)"); continue; }
        if (isNoopHead(effHead(argv))) continue;
        if (isScriptCommand(argv, /\.github\/scripts\/promote-image\.sh/)) continue;
        v.push(name + ": registry-write job runs a non-promote command (" + JSON.stringify(argv.join(" ").slice(0, 70)) + ") — only bare promote-image.sh may run with registry creds; any other client (crane/regctl/oras/curl) can re-point a tag (R42)");
      }
    }
  }
  // npm publish must derive its dist-tag from the execution-tested npm-dist-tag.sh
  // (pre-release -> next, never latest) and pass it via --tag, enabled (R27).
  for (const [name, j] of Object.entries(jobs)) {
    const pub = (j.steps || []).find((s) => /npm\s+publish/.test(lr(s.run)));
    if (!pub) continue;
    const rn = lr(pub.run);
    if (!/npm-dist-tag\.sh/.test(rn)) v.push(name + ": npm publish does not derive --tag from npm-dist-tag.sh");
    if (!/--tag\b/.test(rn)) v.push(name + ": npm publish without --tag");
    // --tag must actually USE the npm-dist-tag.sh result, not a literal: capture
    // the var assigned from `$(… npm-dist-tag.sh …)` and require `--tag "$VAR"` —
    // a `NPM_TAG=$(…); npm publish --tag latest` ignores the routing (R32).
    const dm = rn.match(/(\w+)=["']?\$\((?:\s*bash\s+)?[^)]*npm-dist-tag\.sh[^)]*\)/);
    if (dm) { if (!new RegExp("--tag\\s+[\"']?\\$\\{?" + dm[1] + "\\b").test(rn)) v.push(name + ": npm publish --tag does not use $" + dm[1] + " from npm-dist-tag.sh (a literal --tag ignores the pre-release routing)"); }
    else if (/npm-dist-tag\.sh/.test(rn)) v.push(name + ": npm-dist-tag.sh output is not captured into a variable for --tag");
    for (const r of stepDisabled(pub, PUSH_TAG)) v.push(name + " (npm publish) " + r);
  }
  // ANY `npm dist-tag add` in a release job re-points a dist-tag after publish —
  // ban it outright, not just a literal `latest`: the target can be a `$TAG`
  // variable or a `${…}` expansion the literal match misses, and the dist-tag must
  // come ONLY from `--tag $NPM_TAG` at publish (R34 + R35).
  for (const [name, j] of Object.entries(jobs))
    if (runsCmd(lr((j.steps || []).map((s) => s.run || "").join("\n")), ["dist-tag", "add"])) v.push(name + ": runs `npm dist-tag add` — the dist-tag must come only from `--tag $NPM_TAG` at publish, never re-pointed afterward");
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
  // Map each image to the id of ITS build-push-action step — the ONLY legit source
  // of steps.<id>.outputs.digest. A build with no id can't be referenced; a digest
  // consumed from a different id (a decoy step that writes digest=sha256:… to
  // $GITHUB_OUTPUT under the consumed id, the real build renamed away) is NOT the
  // built image (R33).
  const buildId = {};
  for (const { img, file } of IMAGES) {
    const b = builds.find((s) => String(s.with?.file) === file);
    if (!b) { v.push(cn + ": no build of " + img + " from " + file); continue; }
    if (String(b.with?.push) !== "true") v.push(cn + ": " + img + " build does not push");
    if (typeof b.id !== "string" || !b.id.trim()) v.push(cn + ": " + img + " build (" + file + ") has no step id — its digest output can't be referenced");
    else buildId[img] = b.id.trim();
  }
  // The digest smoke + sha-tag consume MUST be THIS image's build output —
  // steps.<buildId>.outputs.digest — not any steps.<id> (R33). Falls back to a
  // loose match only when the build/id is already reported missing above.
  const digestRe = (img) => new RegExp(img + "@\\$\\{\\{\\s*steps\\." + (buildId[img] ? buildId[img].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\w+") + "\\.outputs\\.digest");
  for (const s of builds) if (/:sha-\$\{\{\s*github\.sha\s*\}\}/.test(String(s.with?.tags ?? ""))) v.push(cn + ": a build tags :sha-${{ github.sha }} directly (must be tagged only AFTER smoke)");
  // The smoke logic (boot + extension, validator + JWT_SECRET rejection, BOTH
  // arches via --platform "$PLAT") lives in the smoke-*.sh scripts, exercised on
  // CI (R27). The candidate must CALL smoke-postgres.sh AND smoke-proxy.sh, each
  // enabled (real shell, if fires on a master push, not coe), and create the
  // sha-<sha> tag (what release resolves) ONLY AFTER both smokes — a
  // create-before-smoke re-exposes finding 1.
  const idx = (re) => steps.findIndex((s) => re.test(lr(s.run)));
  const pgSmoke = idx(/smoke-postgres\.sh/);
  const pxSmoke = idx(/smoke-proxy\.sh/);
  const tagIdx = idx(/imagetools\s+create[^\n]*:sha-\$\{\{\s*github\.sha/);
  // each smoke must be passed the EXACT built @digest — not a mutable tag like
  // :latest or :sha-… (smoking the wrong bytes) — gemini R29.
  if (pgSmoke < 0) v.push(cn + ": does not call smoke-postgres.sh (the postgres digest would ship unsmoked)");
  else { for (const r of stepDisabled(steps[pgSmoke], PUSH_MASTER)) v.push(cn + " (postgres smoke) " + r); for (const r of bareCall(steps[pgSmoke], "smoke-postgres.sh")) v.push(cn + " (postgres smoke) " + r); if (!digestRe("pgstack-postgres").test(lr(steps[pgSmoke].run))) v.push(cn + ": smoke-postgres is not passed pgstack-postgres@${{ steps." + (buildId["pgstack-postgres"] || "*") + ".outputs.digest }} (not THIS image's build digest — a mutable tag or a decoy step's output)"); }
  if (pxSmoke < 0) v.push(cn + ": does not call smoke-proxy.sh (the proxy digest would ship unsmoked)");
  else { for (const r of stepDisabled(steps[pxSmoke], PUSH_MASTER)) v.push(cn + " (proxy smoke) " + r); for (const r of bareCall(steps[pxSmoke], "smoke-proxy.sh")) v.push(cn + " (proxy smoke) " + r); if (!digestRe("pgstack-proxy").test(lr(steps[pxSmoke].run))) v.push(cn + ": smoke-proxy is not passed pgstack-proxy@${{ steps." + (buildId["pgstack-proxy"] || "*") + ".outputs.digest }} (not THIS image's build digest — a mutable tag or a decoy step's output)"); }
  if (tagIdx < 0) v.push(cn + ": does not create the sha-${{ github.sha }} tag release resolves");
  else {
    for (const r of stepDisabled(steps[tagIdx], PUSH_MASTER)) v.push(cn + " (sha-tag) " + r);
    if (pgSmoke < 0 || pxSmoke < 0 || tagIdx < pgSmoke || tagIdx < pxSmoke) v.push(cn + ": sha-${{ github.sha }} is created before both smokes pass (tag-after-smoke order)");
    // EVERY `imagetools create … <img>:sha-${{github.sha}}` line — across ALL steps,
    // not just the canonical tag step — must source THIS image's build digest
    // (steps.<buildId>.outputs.digest, same image repo). A later step (or a 2nd
    // line) re-creating the sha tag from :latest / a foreign digest would otherwise
    // OVERWRITE the smoke-passed manifest, last-writer-wins (R32 + R33 + R34).
    const tagCmds = steps.flatMap((s) => shellCommands(lr(s.run)));
    for (const img of ["pgstack-proxy", "pgstack-postgres"]) {
      const shaTagRe = new RegExp(img + ":sha-\\$\\{\\{\\s*github\\.sha\\b");
      // a sha-tag-DEFINING command — `imagetools create`, `manifest create`, or
      // `docker tag` — must source THIS image's build digest, whichever primitive
      // it uses (gemini R41-1).
      const created = tagCmds.filter((argv) => (seqIn(argv, ["imagetools", "create"]) || seqIn(argv, ["manifest", "create"]) || seqIn(argv, ["docker", "tag"])) && argv.some((t) => shaTagRe.test(t)));
      if (!created.length) { v.push(cn + ": no sha-${{ github.sha }} tag created for " + img); continue; }
      for (const argv of created) if (!argv.some((t) => digestRe(img).test(t))) v.push(cn + ": " + img + " sha-${{ github.sha }} tag created from a non-build digest (foreign image/digest, decoy step, mutable tag, or quoted-fragment command): " + JSON.stringify(argv.join(" ")));
    }
  }
  // R42: the candidate holds packages:write and docker-logs-in, so any registry
  // client (crane/regctl/oras, a curl manifest PUT) could OVERWRITE the
  // sha-${{github.sha}} tag past the digest-bound imagetools-create check above
  // (last-writer-wins). Same allowlist discipline: every command it runs must be a
  // smoke script, the canonical `docker buildx imagetools create`, a container
  // teardown (`docker rm`), or a shell no-op. An unknown command head is rejected.
  const allowedCand = (argv) => {
    if (hasCmdSub(argv)) return false; // $()/backtick runs a side command before the host (R43)
    if (isNoopHead(effHead(argv))) return true;
    if (isScriptCommand(argv, /\.github\/scripts\/smoke-(?:postgres|proxy)\.sh/)) return true;
    return seqIn(argv, ["imagetools", "create"]) || seqIn(argv, ["docker", "rm"]);
  };
  for (const s of steps) {
    if (hasHeredoc(s.run)) v.push(cn + ": uses a heredoc/here-string (<<) — its body live-expands command substitutions the guard can't inspect (R44)");
    for (const argv of shellCommands(lr(s.run)))
      if (argv.length && !allowedCand(argv)) v.push(cn + ": runs a non-allowlisted command (" + JSON.stringify(argv.join(" ").slice(0, 70)) + ") — a registry-write job is allowlisted to smoke scripts, docker buildx imagetools create, docker rm, and shell no-ops; any other client can re-point the sha tag (R42)");
  }
  return v;
}

const deploy = load("deploy.yml");
const release = load("release.yml");
const ci = load("ci.yml");

console.log("=== CI/CD supply-chain gating (FR-B.11.3) ===");
console.log("-- real workflows must be clean --");
const dV = deployPolicy(deploy), rV = releasePolicy(release), cV = ciPolicy(ci), candV = candidatePolicy(ci), scV = scriptsContract();
check(dV.length === 0, `deploy policy clean${dV.length ? " — " + dV.join("; ") : ""}`);
check(rV.length === 0, `release policy clean${rV.length ? " — " + rV.join("; ") : ""}`);
check(cV.length === 0, `ci hardening clean${cV.length ? " — " + cV.join("; ") : ""}`);
check(candV.length === 0, `ci candidate publisher clean${candV.length ? " — " + candV.join("; ") : ""}`);
check(scV.length === 0, `gate scripts exist + execution-tested${scV.length ? " — " + scV.join("; ") : ""}`);
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
const findStep = (w, job, re) => w.jobs[job].steps.find((s) => re.test(String(s.run || "")));
// ── deploy: gate if / DEPLOY_SHA / SSH reset (still inline) / triggers / script gate ──
mut("deploy if drops event==push", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'master'"; }, deployPolicy);
mut("deploy if true || conds", deploy, (w) => { w.jobs.deploy.if = "true || (" + DGATE + ")"; }, deployPolicy);
mut("deploy if allows master||main", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || github.event.workflow_run.head_branch == 'main')"; }, deployPolicy);
mut("deploy downstream if: always()", deploy, (w) => { w.jobs["deploy-polyglot"].if = "always()"; }, deployPolicy);
mut("deploy if unparseable", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion =~ /success/"; }, deployPolicy);
mut("deploy if uses unknown fn fromJSON('true')", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || fromJSON('true'))"; }, deployPolicy);
mut("deploy if allows master||release", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && (github.event.workflow_run.head_branch == 'master' || github.event.workflow_run.head_branch == 'release')"; }, deployPolicy);
mut("deploy if head_branch != decoy", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch != 'nonexistent'"; }, deployPolicy);
mut("deploy if head_branch self-compare", deploy, (w) => { w.jobs.deploy.if = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.workflow_run.head_branch"; }, deployPolicy);
mut("deploy if || workflow_run.id (unmodeled truthy)", deploy, (w) => { w.jobs.deploy.if = DGATE + " || github.event.workflow_run.id"; }, deployPolicy);
mut("deploy allows workflow_dispatch on any ref", deploy, (w) => { w.jobs.deploy.if = DGATE; }, deployPolicy);
mut("deploy DEPLOY_SHA wrong order", deploy, (w) => { sshStep(w).env.DEPLOY_SHA = "${{ github.sha || github.event.workflow_run.head_sha }}"; }, deployPolicy);
mut("deploy decoy job-env + step-env github.sha", deploy, (w) => { w.jobs.deploy.env = { DEPLOY_SHA: "${{ github.event.workflow_run.head_sha }}" }; sshStep(w).env.DEPLOY_SHA = "${{ github.sha }}"; }, deployPolicy);
mut("deploy job continue-on-error", deploy, (w) => { w.jobs.deploy["continue-on-error"] = true; }, deployPolicy);
mut("deploy SSH step continue-on-error", deploy, (w) => { sshStep(w)["continue-on-error"] = true; }, deployPolicy);
mut("deploy SSH reset to a branch (master)", deploy, (w) => { sshStep(w).with.script = "git reset --hard master"; }, deployPolicy);
mut("deploy SSH reset to \"${DEPLOY_SHA}^\"", deploy, (w) => { sshStep(w).with.script = "git fetch origin\ngit reset --hard \"${DEPLOY_SHA}^\""; }, deployPolicy);
mut("deploy SSH reset to \"$DEPLOY_SHA\"~1", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"~1"; }, deployPolicy);
mut("deploy SSH good reset + extra reset to master", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"\ngit reset --hard master"; }, deployPolicy);
mut("deploy SSH git -C . switch master after reset", deploy, (w) => { sshStep(w).with.script = "git reset --hard \"$DEPLOY_SHA\"\ngit -C . switch master"; }, deployPolicy);
mut("deploy SSH script uses github.sha", deploy, (w) => { sshStep(w).with.script = "git reset --hard ${{ github.sha }}"; }, deployPolicy);
mut("deploy downstream job resets master", deploy, (w) => { w.jobs.evil = { needs: "deploy", "runs-on": ["self-hosted"], steps: [{ uses: "appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2", with: { script: "git reset --hard master" } }] }; }, deployPolicy);
mut("deploy listens to Smoke not CI", deploy, (w) => { w.on.workflow_run.workflows = ["Smoke"]; }, deployPolicy);
mut("deploy types: [requested]", deploy, (w) => { w.on.workflow_run.types = ["requested"]; }, deployPolicy);
mut("deploy adds schedule trigger", deploy, (w) => { w.on.schedule = [{ cron: "0 0 * * *" }]; }, deployPolicy);
mut("deploy gate drops require-green-ci.sh", deploy, (w) => { findStep(w, "deploy", /require-green-ci\.sh/).run = "echo skip"; }, deployPolicy);
mut("deploy gate via fake shell (true {0})", deploy, (w) => { findStep(w, "deploy", /require-green-ci\.sh/).shell = "true {0}"; }, deployPolicy);
mut("deploy gate if never fires (&& false)", deploy, (w) => { findStep(w, "deploy", /require-green-ci\.sh/).if = "github.event_name == 'workflow_dispatch' && false"; }, deployPolicy);
mut("deploy gate continue-on-error", deploy, (w) => { findStep(w, "deploy", /require-green-ci\.sh/)["continue-on-error"] = true; }, deployPolicy);
mut("deploy gate runs AFTER the SSH deploy", deploy, (w) => { const st = w.jobs.deploy.steps; const gi = st.findIndex((s) => /require-green-ci\.sh/.test(s.run || "")); st.push(st.splice(gi, 1)[0]); }, deployPolicy);
// ── release: triggers / ci-gate scripts / promote scripts / npm / no-rebuild ──
mut("release adds workflow_dispatch trigger", release, (w) => { w.on.workflow_dispatch = {}; }, releasePolicy);
mut("release push.branches alongside tags", release, (w) => { w.on.push.branches = ["**"]; }, releasePolicy);
mut("release tag pattern bare *", release, (w) => { w.on.push.tags = ["*"]; }, releasePolicy);
mut("release ci-gate job continue-on-error", release, (w) => { w.jobs["ci-gate"]["continue-on-error"] = true; }, releasePolicy);
mut("release ci-gate drops require-green-ci.sh", release, (w) => { findStep(w, "ci-gate", /require-green-ci\.sh/).run = "echo skip"; }, releasePolicy);
mut("release ci-gate drops validate-release-version.sh", release, (w) => { findStep(w, "ci-gate", /validate-release-version\.sh/).run = "echo skip"; }, releasePolicy);
mut("release ci-gate require-green via fake shell", release, (w) => { findStep(w, "ci-gate", /require-green-ci\.sh/).shell = "true {0}"; }, releasePolicy);
mut("release ci-gate validate-version if: false", release, (w) => { findStep(w, "ci-gate", /validate-release-version\.sh/).if = "false"; }, releasePolicy);
mut("release ci-gate validate-version continue-on-error", release, (w) => { findStep(w, "ci-gate", /validate-release-version\.sh/)["continue-on-error"] = true; }, releasePolicy);
mut("release publisher if: always()", release, (w) => { w.jobs["docker-proxy"].if = "always()"; }, releasePolicy);
mut("release publisher drops needs", release, (w) => { delete w.jobs["docker-proxy"].needs; }, releasePolicy);
mut("release docker-postgres promotes the proxy repo", release, (w) => { const s = findStep(w, "docker-postgres", /promote-image\.sh/); s.run = s.run.replace(/pgstack-postgres/g, "pgstack-proxy"); }, releasePolicy);
mut("release drops the postgres promote", release, (w) => { findStep(w, "docker-postgres", /promote-image\.sh/).run = "echo skip"; }, releasePolicy);
mut("release promote via fake shell", release, (w) => { findStep(w, "docker-proxy", /promote-image\.sh/).shell = "true {0}"; }, releasePolicy);
mut("release promote step continue-on-error", release, (w) => { findStep(w, "docker-proxy", /promote-image\.sh/)["continue-on-error"] = true; }, releasePolicy);
mut("release rebuilds via build-push-action", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "Build", uses: "docker/build-push-action@ca052bb54ab0790a636c9b5f226502c73d547a25", with: { file: "./proxy-go/Dockerfile", push: true } }); }, releasePolicy);
mut("release runs docker build", release, (w) => { w.jobs["docker-postgres"].steps.push({ name: "Build", run: "docker buildx build -t x ." }); }, releasePolicy);
mut("release npm publish without --tag", release, (w) => { const s = findStep(w, "npm-sdk", /npm publish/); s.run = s.run.replace(/\s--tag "?\$NPM_TAG"?/, ""); }, releasePolicy);
mut("release npm publish drops npm-dist-tag.sh", release, (w) => { findStep(w, "npm-sdk", /npm publish/).run = "npm publish --provenance --access public --tag latest"; }, releasePolicy);
mut("release checkout persists credentials", release, (w) => { for (const j of Object.values(w.jobs)) { const cs = (j.steps || []).find((s) => typeof s.uses === "string" && /actions\/checkout@/.test(s.uses)); if (cs) { cs.with = { ...(cs.with || {}), "persist-credentials": true }; return; } } }, releasePolicy);
// ── candidate (ci build-publish-images) ──
mut("ci candidate proxy build push: false", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => String(st.with?.file) === "./proxy-go/Dockerfile"); s.with.push = false; }, candidatePolicy);
mut("ci candidate drops the postgres build", ci, (w) => { const j = w.jobs["build-publish-images"]; j.steps = j.steps.filter((st) => String(st.with?.file) !== "./Dockerfile.dev"); }, candidatePolicy);
mut("ci candidate builds postgres from proxy Dockerfile", ci, (w) => { const s = w.jobs["build-publish-images"].steps.find((st) => String(st.with?.file) === "./Dockerfile.dev"); s.with.file = "./proxy-go/Dockerfile"; }, candidatePolicy);
mut("ci candidate drops all needs", ci, (w) => { delete w.jobs["build-publish-images"].needs; }, candidatePolicy);
mut("ci candidate drops six suite gates", ci, (w) => { w.jobs["build-publish-images"].needs = ["test-proxy-go", "test-e2e", "test-security", "test-prod-validator"]; }, candidatePolicy);
mut("ci candidate runs on any push branch", ci, (w) => { w.jobs["build-publish-images"].if = "github.event_name == 'push'"; }, candidatePolicy);
mut("ci candidate drops smoke-postgres.sh", ci, (w) => { findStep(w, "build-publish-images", /smoke-postgres\.sh/).run = "echo skip"; }, candidatePolicy);
mut("ci candidate drops smoke-proxy.sh", ci, (w) => { findStep(w, "build-publish-images", /smoke-proxy\.sh/).run = "echo skip"; }, candidatePolicy);
mut("ci candidate smoke via fake shell", ci, (w) => { findStep(w, "build-publish-images", /smoke-proxy\.sh/).shell = "true {0}"; }, candidatePolicy);
mut("ci candidate smoke if: false", ci, (w) => { findStep(w, "build-publish-images", /smoke-postgres\.sh/).if = "false"; }, candidatePolicy);
mut("ci candidate smoke continue-on-error", ci, (w) => { findStep(w, "build-publish-images", /smoke-proxy\.sh/)["continue-on-error"] = true; }, candidatePolicy);
mut("ci candidate sha-tag if: always()", ci, (w) => { findStep(w, "build-publish-images", /imagetools create[^\n]*:sha-/).if = "always()"; }, candidatePolicy);
mut("ci candidate tags sha BEFORE smoke", ci, (w) => { const st = w.jobs["build-publish-images"].steps; const ti = st.findIndex((s) => /imagetools create[^\n]*:sha-/.test(s.run || "")); const tag = st.splice(ti, 1)[0]; const bi = st.findIndex((s) => /build-push/.test(s.uses || "")); st.splice(bi + 1, 0, tag); }, candidatePolicy);
// ── ci hardening ──
mut("ci checkout persist-credentials: true", ci, (w) => { const j = Object.values(w.jobs)[0]; const cs = (j.steps || []).find((s) => typeof s.uses === "string" && /actions\/checkout@/.test(s.uses)); cs.with = { ...(cs.with || {}), "persist-credentials": true }; }, ciPolicy);
mut("ci permissions: write-all", ci, (w) => { w.permissions = "write-all"; }, ciPolicy);
mut("ci govulncheck@latest", ci, (w) => { const j = Object.values(w.jobs).find((x) => (x.steps || []).some((s) => /govulncheck/.test(s.run || ""))); const s = j.steps.find((st) => /govulncheck/.test(st.run || "")); s.run = s.run.replace(/govulncheck@v[\d.]+/, "govulncheck@latest"); }, ciPolicy);
mut("ci adds pull_request_target", ci, (w) => { w.on.pull_request_target = {}; }, ciPolicy);
mut("ci PR job unconditional self-hosted", ci, (w) => { Object.values(w.jobs)[0]["runs-on"] = ["self-hosted", "Linux", "X64"]; }, ciPolicy);
mut("ci PR job self-hosted via matrix.include", ci, (w) => { const j = Object.values(w.jobs)[0]; j.strategy = { matrix: { include: [{ runner: "self-hosted" }] } }; j["runs-on"] = "${{ matrix.runner }}"; }, ciPolicy);
mut("ci PR job routes pull_request to self-hosted (inverted)", ci, (w) => { Object.values(w.jobs)[0]["runs-on"] = "${{ (github.event_name == 'pull_request') && fromJSON('[\"self-hosted\", \"Linux\", \"X64\"]') || fromJSON('[\"ubuntu-latest\"]') }}"; }, ciPolicy);
mut("ci job contents: write", ci, (w) => { Object.values(w.jobs)[0].permissions = { contents: "write" }; }, ciPolicy);
// ── pinning ──
mut("pin step uses @mutable tag", deploy, (w) => { sshStep(w).uses = "appleboy/ssh-action@v1"; }, pinPolicy);
mut("pin job-level uses @main", release, (w) => { w.jobs.evil = { uses: "attacker/wf@main" }; }, pinPolicy);
mut("pin docker://image:latest", release, (w) => { w.jobs["ci-gate"].steps.push({ uses: "docker://alpine:latest" }); }, pinPolicy);
mut("pin job container :latest", release, (w) => { w.jobs["ci-gate"].container = "alpine:latest"; }, pinPolicy);
mut("pin service image :latest", release, (w) => { w.jobs["ci-gate"].services = { db: { image: "postgres:latest" } }; }, pinPolicy);
// R28 finding 3 — script-disable bypasses (swallow / comment-only / fake shell)
mut("deploy gate call swallowed by || true", deploy, (w) => { const s = findStep(w, "deploy", /require-green-ci\.sh/); s.run = s.run + " || true"; }, deployPolicy);
mut("release ci-gate validate-version only in a comment", release, (w) => { findStep(w, "ci-gate", /validate-release-version\.sh/).run = "# bash .github/scripts/validate-release-version.sh decoy\necho ok"; }, releasePolicy);
mut("release promote swallowed by || true", release, (w) => { const s = findStep(w, "docker-proxy", /promote-image\.sh/); s.run = s.run + " || true"; }, releasePolicy);
mut("ci candidate smoke via shell bash -c 'true' {0}", ci, (w) => { findStep(w, "build-publish-images", /smoke-proxy\.sh/).shell = "bash -c 'true' {0}"; }, candidatePolicy);
mut("ci candidate smoke name only in a comment", ci, (w) => { findStep(w, "build-publish-images", /smoke-postgres\.sh/).run = "# bash .github/scripts/smoke-postgres.sh decoy\necho ok"; }, candidatePolicy);
// R29 finding 3 — guard must check the script ARGS, not just the call site
mut("deploy gate dead-branched by true ||", deploy, (w) => { const s = findStep(w, "deploy", /require-green-ci\.sh/); s.run = "true || " + s.run; }, deployPolicy);
mut("deploy gate passes a hardcoded SHA", deploy, (w) => { const s = findStep(w, "deploy", /require-green-ci\.sh/); s.run = s.run.replace(/\$\{\{\s*github\.sha\s*\}\}/, "abc123"); }, deployPolicy);
mut("release ci-gate require-green passes a hardcoded SHA", release, (w) => { const s = findStep(w, "ci-gate", /require-green-ci\.sh/); s.run = s.run.replace(/\$\{\{\s*github\.sha\s*\}\}/, "0000000"); }, releasePolicy);
mut("release ci-gate validates a hardcoded tag (not ref_name)", release, (w) => { const s = findStep(w, "ci-gate", /validate-release-version\.sh/); s.run = s.run.replace(/\$\{\{\s*github\.ref_name\s*\}\}/, "v9.9.9"); }, releasePolicy);
mut("release promote passes a foreign SHA", release, (w) => { const s = findStep(w, "docker-proxy", /promote-image\.sh/); s.run = s.run.replace(/\$\{\{\s*github\.sha\s*\}\}/, "deadbeef"); }, releasePolicy);
mut("ci candidate smokes :latest instead of the built digest", ci, (w) => { const s = findStep(w, "build-publish-images", /smoke-postgres\.sh/); s.run = s.run.replace(/@\$\{\{\s*steps\.\w+\.outputs\.digest\s*\}\}/, ":latest"); }, candidatePolicy);
// R30 finding — script disabled by an unreachable block or a shell control operator
mut("deploy gate shell `bash {0} || true` (swallow)", deploy, (w) => { findStep(w, "deploy", /require-green-ci\.sh/).shell = "bash {0} || true"; }, deployPolicy);
mut("deploy gate inside `if false; then …; fi`", deploy, (w) => { const s = findStep(w, "deploy", /require-green-ci\.sh/); s.run = "if false; then " + s.run + "; fi"; }, deployPolicy);
mut("release ci-gate validate inside `if false` block", release, (w) => { const s = findStep(w, "ci-gate", /validate-release-version\.sh/); s.run = "if false; then " + s.run + "; fi"; }, releasePolicy);
mut("ci candidate smoke shell `bash {0} || true`", ci, (w) => { findStep(w, "build-publish-images", /smoke-proxy\.sh/).shell = "bash {0} || true"; }, candidatePolicy);
// R31 finding — a LIVE shell wrapper around the call swallows its non-zero exit:
// `if ! script; then echo ok; fi`, `script || echo ok`, `script | cat`. stripDead
// can't strip these (the `if` is reachable), and the run-swallow regex only knew
// `|| true|:|exit 0`. A critical script must be a BARE single-command call.
mut("deploy gate wrapped in `if ! …; then echo ok; fi`", deploy, (w) => { const s = findStep(w, "deploy", /require-green-ci\.sh/); s.run = "if ! " + s.run + "; then echo ok; fi"; }, deployPolicy);
mut("release ci-gate validate wrapped in `if ! …; then echo ok; fi`", release, (w) => { const s = findStep(w, "ci-gate", /validate-release-version\.sh/); s.run = "if ! " + s.run + "; then echo ok; fi"; }, releasePolicy);
mut("release promote swallowed by `|| echo ok`", release, (w) => { const s = findStep(w, "docker-proxy", /promote-image\.sh/); s.run = s.run + " || echo ok"; }, releasePolicy);
mut("ci candidate smoke swallowed by `|| echo ok`", ci, (w) => { const s = findStep(w, "build-publish-images", /smoke-proxy\.sh/); s.run = s.run + " || echo ok"; }, candidatePolicy);
mut("ci candidate smoke piped to `| cat` (swallows without pipefail)", ci, (w) => { const s = findStep(w, "build-publish-images", /smoke-postgres\.sh/); s.run = s.run + " | cat"; }, candidatePolicy);
// R32 finding — the guard FINDS the right element but doesn't BIND it tightly:
// (1) the sha-<sha> tag step must source each image's tag from THAT image's
// smoke-passed digest, not a foreign digest or a mutable :latest; (2) the promote
// check inspected the FIRST promote-image.sh step in the job, so a decoy step with
// the right SHA hid a real promote on a foreign SHA; (3) npm --tag presence ≠ the
// --tag value actually being the npm-dist-tag.sh result.
mut("ci candidate proxy sha-tag sourced from the postgres digest", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run.replace(/pgstack-proxy@\$\{\{\s*steps\.proxy\.outputs\.digest\s*\}\}/, "pgstack-postgres@${{ steps.postgres.outputs.digest }}"); }, candidatePolicy);
mut("ci candidate proxy sha-tag sourced from a mutable :latest", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run.replace(/pgstack-proxy@\$\{\{\s*steps\.proxy\.outputs\.digest\s*\}\}/, "pgstack-proxy:latest"); }, candidatePolicy);
mut("ci candidate postgres sha-tag sourced from the proxy digest", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-postgres:sha-/); s.run = s.run.replace(/pgstack-postgres@\$\{\{\s*steps\.postgres\.outputs\.digest\s*\}\}/, "pgstack-proxy@${{ steps.proxy.outputs.digest }}"); }, candidatePolicy);
mut("release postgres promote: decoy step hides a foreign-SHA real promote", release, (w) => { const j = w.jobs["docker-postgres"]; const real = j.steps.find((s) => /promote-image\.sh/.test(String(s.run || ""))); const i = j.steps.indexOf(real); const decoy = { name: "decoy promote", run: real.run }; real.run = real.run.replace(/\$\{\{\s*github\.sha\s*\}\}/, "deadbeef"); j.steps.splice(i, 0, decoy); }, releasePolicy);
mut("release npm publish --tag uses a literal, not $NPM_TAG from npm-dist-tag.sh", release, (w) => { const s = findStep(w, "npm-sdk", /npm publish/); s.run = s.run.replace(/--tag\s+"?\$\{?NPM_TAG\}?"?/, "--tag latest"); }, releasePolicy);
// R33 finding — the digest smoke/tag consume must be THIS image's build output.
// Renaming the real build's id and adding a decoy step that writes the consumed
// id's digest to $GITHUB_OUTPUT lets smoke/tag use an attacker-supplied digest.
mut("ci candidate proxy digest comes from a decoy step, not the proxy build", ci, (w) => { const j = w.jobs["build-publish-images"]; const b = j.steps.find((s) => String(s.with?.file) === "./proxy-go/Dockerfile"); b.id = "proxy_build"; const bi = j.steps.indexOf(b); j.steps.splice(bi + 1, 0, { id: "proxy", run: 'echo "digest=sha256:dead" >> "$GITHUB_OUTPUT"' }); }, candidatePolicy);
mut("ci candidate postgres digest comes from a decoy step, not the postgres build", ci, (w) => { const j = w.jobs["build-publish-images"]; const b = j.steps.find((s) => String(s.with?.file) === "./Dockerfile.dev"); b.id = "postgres_build"; const bi = j.steps.indexOf(b); j.steps.splice(bi + 1, 0, { id: "postgres", run: 'echo "digest=sha256:dead" >> "$GITHUB_OUTPUT"' }); }, candidatePolicy);
mut("ci candidate proxy build has no step id (digest output unreferenceable)", ci, (w) => { const b = w.jobs["build-publish-images"].steps.find((s) => String(s.with?.file) === "./proxy-go/Dockerfile"); delete b.id; }, candidatePolicy);
// R34 finding — OVERWRITE after a correct step (last-writer-wins): a later
// create/dist-tag re-points an artifact the canonical step set correctly.
mut("ci candidate sha-tag step has a 2nd line overwriting proxy:sha from :latest", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\ndocker buildx imagetools create -t "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}" "${IMAGE_PREFIX}/pgstack-proxy:latest"'; }, candidatePolicy);
mut("ci candidate adds a later step overwriting proxy:sha from :latest", ci, (w) => { w.jobs["build-publish-images"].steps.push({ name: "overwrite", run: 'docker buildx imagetools create -t "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}" "${IMAGE_PREFIX}/pgstack-proxy:latest"' }); }, candidatePolicy);
mut("release docker-proxy runs a direct imagetools create re-pointing the release tag from :latest", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "overwrite", run: 'docker buildx imagetools create -t "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest"' }); }, releasePolicy);
mut("release npm-sdk runs `npm dist-tag add … latest` after publish", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "promote latest", run: "npm dist-tag add @pgstack/sdk@${{ github.ref_name }} latest" }); }, releasePolicy);
// R35 finding — R34's line/literal matching is beaten by shell line-continuations
// (`\` + newline splits the command token) and variable indirection (`$TAG`).
mut("ci candidate sha-tag overwrite split across a `\\`-continuation", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\ndocker buildx imagetools \\\n  create -t "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}" "${IMAGE_PREFIX}/pgstack-proxy:latest"'; }, candidatePolicy);
mut("release direct imagetools create split across a `\\`-continuation", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'docker buildx imagetools \\\n  create -t "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest"' }); }, releasePolicy);
mut("release npm dist-tag add split across a `\\`-continuation", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: 'npm dist-tag \\\n  add "@pgstack/sdk@${GITHUB_REF_NAME#v}" latest' }); }, releasePolicy);
mut("release npm dist-tag add latest via a `$TAG` variable", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: 'TAG=latest\nnpm dist-tag add "@pgstack/sdk@${GITHUB_REF_NAME#v}" "$TAG"' }); }, releasePolicy);
// R36 finding — the shell joins QUOTED FRAGMENTS into one argv token, so literal
// token-matching is beaten: image"tools" -> imagetools, dist"-tag" -> dist-tag,
// a"dd" -> add. Must tokenize to argv (quote chars removed) before matching.
mut('ci candidate sha-tag overwrite via quoted-fragment image"tools"', ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\ndocker buildx image"tools" create -t "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}" "${IMAGE_PREFIX}/pgstack-proxy:latest"'; }, candidatePolicy);
mut('release direct imagetools create via quoted-fragment image"tools"', release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'docker buildx image"tools" create -t "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest"' }); }, releasePolicy);
mut('release npm dist-tag add via quoted-fragment dist"-tag"', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: 'npm dist"-tag" add "@pgstack/sdk@${GITHUB_REF_NAME#v}" latest' }); }, releasePolicy);
mut('release npm dist-tag add via quoted-fragment a"dd"', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: 'npm dist-tag a"dd" "@pgstack/sdk@${GITHUB_REF_NAME#v}" latest' }); }, releasePolicy);
// R37 finding — Bash ANSI-C quoting ($'…') and backslash escaping also concatenate
// into one argv word: image$'tools' / dist$'-tag' / a$'dd' / a\dd -> imagetools /
// dist-tag / add. The tokenizer must model these like the shell does.
mut("ci candidate sha-tag overwrite via ANSI-C image$'tools'", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\ndocker buildx image$'tools' create -t \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\" \"${IMAGE_PREFIX}/pgstack-proxy:latest\""; }, candidatePolicy);
mut("release direct imagetools create via ANSI-C image$'tools'", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker buildx image$'tools' create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut("release npm dist-tag add via ANSI-C dist$'-tag'", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist$'-tag' add \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut("release npm dist-tag add via ANSI-C a$'dd'", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist-tag a$'dd' \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut("release npm dist-tag add via backslash a\\dd", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist-tag a\\dd \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
// R38 finding — a command/sub-verb token can be a command substitution whose
// output the shell runs as that token: "$(printf imagetools)" create, npm
// "$(printf dist-tag)" add, npm dist-tag "$(printf add)". The value is only known
// at runtime → fail closed: a dynamic token ($()/backtick) in a command position
// matches the forbidden sequence as a wildcard.
mut('ci candidate sha-tag overwrite via command-sub "$(printf imagetools)"', ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\ndocker buildx \"$(printf imagetools)\" create -t \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\" \"${IMAGE_PREFIX}/pgstack-proxy:latest\""; }, candidatePolicy);
mut('release imagetools create via command-sub "$(printf imagetools)"', release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker buildx \"$(printf imagetools)\" create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut('release npm dist-tag add via command-sub "$(printf dist-tag)"', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm \"$(printf dist-tag)\" add \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut('release npm dist-tag add via command-sub "$(printf add)"', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist-tag \"$(printf add)\" \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut("release npm dist-tag add via backtick command-sub", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist-tag \"`printf add`\" \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut("release imagetools create via unquoted $(printf imagetools)", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker buildx $(printf imagetools) create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
// R39 finding — a command/sub-verb token can be a parameter expansion ($VAR /
// ${VAR}) the shell resolves to the forbidden verb. Fail closed: a dynamic token
// in a COMMAND position (after launchers docker/buildx/… only) is a wildcard.
mut('ci candidate sha-tag overwrite via variable "$SUB"', ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\nSUB=imagetools\ndocker buildx \"$SUB\" create -t \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\" \"${IMAGE_PREFIX}/pgstack-proxy:latest\""; }, candidatePolicy);
mut('release imagetools create via variable "$SUB"', release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "SUB=imagetools\ndocker buildx \"$SUB\" create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut('release npm dist-tag add via variable "$SUB" (subcommand)', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "SUB=dist-tag\nnpm \"$SUB\" add \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut('release npm dist-tag add via variable "$SUB" (verb)', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "SUB=add\nnpm dist-tag \"$SUB\" \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
mut('release npm dist-tag add via variable "${SUB}" braces', release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "SUB=add\nnpm dist-tag \"${SUB}\" \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
// R40 finding — CLI OPTIONS interleaved between launcher and subcommand break the
// anchor (the option + its value aren't launchers): docker --context default
// buildx imagetools create / docker buildx --builder default imagetools create /
// npm --prefix sdk dist-tag add. seqIn must skip options (+ their values) in the
// command head, and the npm verb is dist-tag/add (npm is the root, not the verb).
mut("ci candidate sha-tag overwrite via option-interleave docker --context default buildx", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\ndocker --context default buildx imagetools create -t \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\" \"${IMAGE_PREFIX}/pgstack-proxy:latest\""; }, candidatePolicy);
mut("release imagetools create via option-interleave docker --context default buildx", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker --context default buildx imagetools create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut("release imagetools create via option-interleave buildx --builder default", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker buildx --builder default imagetools create -t \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut("release npm dist-tag add via option-interleave npm --prefix sdk", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm --prefix sdk dist-tag add \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
// R41 finding 1 — `docker manifest create`/`docker tag`/`docker push` re-point a
// tag without `imagetools create`, which the guard only looked for.
mut("ci candidate sha-tag overwrite via docker manifest create", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\ndocker manifest create \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\" \"${IMAGE_PREFIX}/pgstack-proxy:latest\"\ndocker manifest push \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\""; }, candidatePolicy);
mut("ci candidate sha-tag overwrite via docker tag", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + "\ndocker tag \"${IMAGE_PREFIX}/pgstack-proxy:latest\" \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\"\ndocker push \"${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\""; }, candidatePolicy);
mut("release tag overwrite via docker manifest create", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker manifest create \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\"" }); }, releasePolicy);
mut("release tag overwrite via docker manifest push", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker manifest push \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\"" }); }, releasePolicy);
mut("release tag overwrite via docker tag", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker tag \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest\" \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\"" }); }, releasePolicy);
mut("release tag overwrite via docker push", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: "docker push \"ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\"" }); }, releasePolicy);
// R41 finding 2 — an option BETWEEN the verbs (npm dist-tag --registry=URL add)
// breaks the consecutive match; seqIn must skip options inside the sequence too.
mut("release npm dist-tag add via option between dist-tag and add", release, (w) => { w.jobs["npm-sdk"].steps.push({ name: "x", run: "npm dist-tag --registry=https://registry.npmjs.org add \"@pgstack/sdk@${GITHUB_REF_NAME#v}\" latest" }); }, releasePolicy);
// R42 finding — blocklisting the docker CLI tag-mutation primitives is a losing
// game: ANY registry client with the job's GHCR creds (crane/regctl/oras, or a
// bare curl manifest PUT — even digest-pinned, even containerized via `docker
// run …crane copy`) can re-point a tag without touching the docker CLI. The fix
// is an ALLOWLIST for write-scoped jobs: a registry-write RELEASE job may run ONLY
// bare promote-image.sh; the CANDIDATE may run ONLY smoke scripts + the canonical
// imagetools-create (+ docker rm teardown + shell no-ops). An unknown command
// head in a write-scoped job is rejected, closing the whole class at once.
mut("release docker-proxy re-points the tag via containerized crane copy", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'docker run --rm -v "$HOME/.docker:/root/.docker:ro" gcr.io/go-containerregistry/crane:debug@sha256:1b1fb24d2b1bb27a9daf81a588157e68463876904e8e537a812edba6284fb252 copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via bare crane copy", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via regctl image copy", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'regctl image copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via oras cp", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'oras cp "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via a curl manifest PUT", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'curl -sSL -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/${{ github.repository_owner }}/pgstack-proxy/manifests/${{ github.ref_name }}" --data-binary @index.json' }); }, releasePolicy);
mut("ci candidate re-points the sha tag via containerized crane copy", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\ndocker run --rm -v "$HOME/.docker:/root/.docker:ro" gcr.io/go-containerregistry/crane:debug@sha256:1b1fb24d2b1bb27a9daf81a588157e68463876904e8e537a812edba6284fb252 copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}"'; }, candidatePolicy);
mut("ci candidate re-points the sha tag via bare crane copy", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\ncrane copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}"'; }, candidatePolicy);
mut("ci candidate re-points the sha tag via regctl image copy", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\nregctl image copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}"'; }, candidatePolicy);
// R43 finding — the allowlist's no-op heads (echo/printf/set/…) are not safe when
// the argument carries a command substitution: the shell runs `$(…)` / backtick
// BEFORE the no-op, so `echo "$(crane copy …)"` re-points a tag while the head
// reads as harmless. Fail-closed: no allowlisted command in a write-scoped job
// may carry a substitution.
mut("release docker-proxy re-points the tag via echo \"$(crane copy …)\"", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'echo "$(crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}")"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via printf \"$(crane copy …)\"", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'printf "%s" "$(crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}")"' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via echo backtick crane copy", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'echo "`crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}"`"' }); }, releasePolicy);
mut("ci candidate re-points the sha tag via echo \"$(crane copy …)\"", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\necho "$(crane copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}")"'; }, candidatePolicy);
mut("ci candidate re-points the sha tag via echo backtick crane copy", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\necho "`crane copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}"`"'; }, candidatePolicy);
// R44 finding — a heredoc body live-expands the substitution, but `lr`/`stripDead`
// discards it before the R43 check runs, so a no-op head (`echo`) + an unquoted
// heredoc whose body is `$(crane copy …)` re-points a tag undetected. Fail-closed:
// no heredoc/here-string (`<<`) in a write-scoped job's run step.
mut("release docker-proxy re-points the tag via echo <<EOF heredoc $(crane copy)", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'echo <<EOF\n$(crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}")\nEOF' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via echo <<-EOF heredoc $(crane copy)", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'echo <<-EOF\n\t$(crane copy "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest" "ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}")\n\tEOF' }); }, releasePolicy);
mut("ci candidate re-points the sha tag via echo <<EOF heredoc $(crane copy)", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\necho <<EOF\n$(crane copy "${IMAGE_PREFIX}/pgstack-proxy:latest" "${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}")\nEOF'; }, candidatePolicy);
// R45 finding — the allowlist accepted ANY argv merely CONTAINING the script
// marker, but a `bash -c "<cmd>" .github/scripts/x.sh` runs `<cmd>` and leaves the
// script as an unexecuted positional ($1). So `bash -c "crane copy …"
// promote-image.sh …` re-points a tag while the marker satisfies the allowlist.
// Fix: the script must be the EFFECTIVE command head (isScriptCommand), not an
// argument behind a `-c` wrapper.
mut("release docker-proxy re-points the tag via `bash -c crane copy` with promote-image.sh as an arg", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'bash -c "crane copy ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}" .github/scripts/promote-image.sh pgstack-proxy ${{ github.sha }}' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via `sh -c crane copy` with promote-image.sh as an arg", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'sh -c "crane copy ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}" .github/scripts/promote-image.sh pgstack-proxy ${{ github.sha }}' }); }, releasePolicy);
mut("ci candidate re-points the sha tag via `bash -c crane copy` with smoke-proxy.sh as an arg", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\nbash -c "crane copy ${IMAGE_PREFIX}/pgstack-proxy:latest ${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}" .github/scripts/smoke-proxy.sh'; }, candidatePolicy);
// R46 finding — GNU `env -S "<cmd>"` (and `--split-string`) split-strings its value
// into argv and RUNS it, exactly like `bash -c` — so `env -S "bash -c 'crane copy
// …'" .github/scripts/promote-image.sh …` runs the crane command while the script
// marker is just a trailing positional. `-S` was passing R45's lead-option skip
// (only `-c` was treated as a command-string wrapper). Now `-S`/`--split-string`
// is refused in the lead too.
mut("release docker-proxy re-points the tag via `env -S` wrapping bash -c, promote-image.sh as an arg", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'env -S "bash -c \'crane copy ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\'" .github/scripts/promote-image.sh pgstack-proxy ${{ github.sha }}' }); }, releasePolicy);
mut("release docker-proxy re-points the tag via `env --split-string` wrapping bash -c", release, (w) => { w.jobs["docker-proxy"].steps.push({ name: "x", run: 'env --split-string="bash -c \'crane copy ghcr.io/${{ github.repository_owner }}/pgstack-proxy:latest ghcr.io/${{ github.repository_owner }}/pgstack-proxy:${{ github.ref_name }}\'" .github/scripts/promote-image.sh pgstack-proxy ${{ github.sha }}' }); }, releasePolicy);
mut("ci candidate re-points the sha tag via `env -S` wrapping bash -c, smoke-proxy.sh as an arg", ci, (w) => { const s = findStep(w, "build-publish-images", /imagetools create[^\n]*pgstack-proxy:sha-/); s.run = s.run + '\nenv -S "bash -c \'crane copy ${IMAGE_PREFIX}/pgstack-proxy:latest ${IMAGE_PREFIX}/pgstack-proxy:sha-${{ github.sha }}\'" .github/scripts/smoke-proxy.sh'; }, candidatePolicy);

if (fail) {
  console.error(`\nFAIL: ${fail} — CI/CD supply-chain gating regressed or the guard missed a known mutation.`);
  process.exit(1);
}
console.log("\nPASS: policy clean on real workflows; all known bypass mutations caught.");
