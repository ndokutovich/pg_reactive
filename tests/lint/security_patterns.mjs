#!/usr/bin/env node
// Static lint for known-unsafe SQL / Markdown patterns.
// Round-31 Tier 3.6 from the SECURITY.md ritual.
//
// Each rule is named after the audit round / SECURITY.md invariant
// it enforces. Rules are intentionally narrow (low false-positive
// rate) and report file:line so the offending block is obvious.
//
// Run:  node tests/lint/security_patterns.mjs
//
// CI runs this in the "Adversarial security" job; failures gate
// merge. To add a rule: write a small function that walks a file's
// lines and pushes findings into the shared array. Name it after
// the round it guards.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname
  .replace(/^\//, "")
  .replace(/\/$/, "");

// Sources we walk. cli/dist, node_modules, build, vendored deps are
// skipped to keep noise down.
const ROOTS = [
  "docker", "docs", "examples", "ext/sql", "ext/expected",
  "migrations", "cli/src", "cli/templates", "proxy-go", "tests",
  "sdk/src", "studio/src", "apps",
];
const SKIP_SEGMENTS = new Set([
  "node_modules", "build", "dist", "target", ".git", "__pycache__", ".cache",
]);

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_SEGMENTS.has(name)) continue;
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const findings = [];

function report(file, lineNo, ruleId, message) {
  findings.push({ file: relative(ROOT, file), line: lineNo, ruleId, message });
}

// Rule SEC-R3 — SECURITY DEFINER must have SET search_path
//   SECURITY.md invariant #3. Audit rounds 21 F2, 28 F2, 29 F2.
//
//   - .sql files: scan top-level lines, but skip lines that are
//     pure SQL comments (`-- ...`) so narrative paragraphs that
//     mention the keyword don't trip the rule.
//   - .md / .mdx files: only check fenced ```sql / ```postgresql
//     blocks. Body prose can freely mention "SECURITY DEFINER".
//   - Within 25 lines after the matched SECURITY DEFINER token,
//     a SET search_path that does NOT include any user schema
//     (public / pgr / pgstack) must follow. Canonical safe pin
//     is `pg_catalog, pg_temp`. Override per-line:
//       -- lint:allow=SEC-R3
function checkSecurityDefiner(file, text) {
  const isSQL = /\.sql$/.test(file);
  const isMD = /\.(md|mdx)$/.test(file);
  if (!isSQL && !isMD) return;

  const rawLines = text.split(/\r?\n/);

  // Build the "active mask" — which line indices are real SQL code
  // (eligible for checking) vs prose/comments (skip).
  const active = new Array(rawLines.length).fill(false);
  if (isSQL) {
    for (let i = 0; i < rawLines.length; i++) {
      if (!/^\s*--/.test(rawLines[i])) active[i] = true;
    }
  } else {
    // Markdown: only inside ```sql / ```postgresql / ```psql blocks.
    let inSqlBlock = false;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const fence = /^```([a-z][a-z0-9+-]*)?/i.exec(line);
      if (fence) {
        if (inSqlBlock) {
          inSqlBlock = false;
        } else {
          const runner = (fence[1] || "").toLowerCase();
          inSqlBlock = runner === "sql" || runner === "postgresql"
            || runner === "postgres" || runner === "psql";
        }
        continue; // the fence line itself is not SQL
      }
      // Even inside an SQL block, a `-- ...` line is a comment.
      if (inSqlBlock && !/^\s*--/.test(line)) active[i] = true;
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    if (!active[i]) continue;
    const line = rawLines[i];
    const m = /\bSECURITY\s+DEFINER\b/i.exec(line);
    if (!m) continue;
    if (/lint:allow=SEC-R3/.test(line)) continue;
    // Skip if the keyword sits inside a string literal — a RAISE
    // EXCEPTION 'including SECURITY DEFINER helpers ...' isn't a
    // function definition. Heuristic: a `'` appears both before AND
    // after the keyword on the same line.
    const before = line.slice(0, m.index);
    const after = line.slice(m.index);
    if (before.includes("'") && after.includes("'")) continue;
    let foundPin = false;
    let unsafePin = false;
    for (let j = i; j < Math.min(i + 25, rawLines.length); j++) {
      const m = /SET\s+search_path\s*=\s*([^\n;]+)/i.exec(rawLines[j]);
      if (!m) continue;
      foundPin = true;
      // Strip trailing SQL comment so `pg_catalog, pg_temp -- NO public`
      // is not flagged for the literal "public" inside the comment.
      const value = m[1].replace(/--.*$/, "").toLowerCase();
      if (/\bpublic\b/.test(value) || /\bpgr\b/.test(value) || /\bpgstack\b/.test(value)) {
        unsafePin = true;
      }
      break;
    }
    if (!foundPin) {
      report(file, i + 1, "SEC-R3",
        "SECURITY DEFINER without SET search_path — pin to pg_catalog, pg_temp");
    } else if (unsafePin) {
      report(file, i + 1, "SEC-R3",
        "SECURITY DEFINER with SET search_path that includes a user schema (public/pgr/pgstack) — use pg_catalog, pg_temp and fully-qualify object refs");
    }
  }
}

// Rule SEC-R28 — no PUBLIC EXECUTE on public.* functions
//   SECURITY.md invariant #2. Audit round 28 F1 HIGH.
//   Flags any explicit GRANT EXECUTE ... TO PUBLIC line.
function checkGrantExecuteToPublic(file, text) {
  if (!/\.(sql|md|mdx)$/.test(file)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R28/.test(line)) continue;
    if (/^\s*--/.test(line)) continue;
    if (/\bGRANT\s+EXECUTE\b.*\bTO\s+PUBLIC\b/i.test(line)) {
      report(file, i + 1, "SEC-R28",
        "GRANT EXECUTE ... TO PUBLIC re-introduces the round-28 RPC default-deny footgun");
    }
  }
}

// Rule SEC-R25 — chiMiddleware.RealIP must never be used in router
//   SECURITY.md invariant #5. Audit round 25 HIGH.
//   The composition_test.go file uses it deliberately as a
//   negative pin; skip that one file.
function checkChiRealIPUsage(file, text) {
  if (!/\.go$/.test(file)) return;
  if (/composition_test\.go$/.test(file)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R25/.test(line)) continue;
    if (/^\s*\/\//.test(line)) continue;
    if (/chiMiddleware\.RealIP\b/.test(line)) {
      report(file, i + 1, "SEC-R25",
        "chiMiddleware.RealIP pre-mutates r.RemoteAddr from spoofable headers; defeats every trusted-proxy gate downstream (round-25 HIGH)");
    }
  }
}

// Rule SEC-R30 — raw-OTP function must not be granted to anon/authenticated
//   SECURITY.md invariant #8. Audit round 30 HIGH.
//   Heuristic: file mentions both a raw token return AND a grant
//   to anon/authenticated/PUBLIC. Narrow on purpose.
function checkRawTokenGrant(file, text) {
  if (!/\.(sql|md|mdx)$/.test(file)) return;
  if (!/RETURN\s+v_token\b|RETURNING\s+token\b/i.test(text)) return;
  if (!/GRANT\s+EXECUTE/i.test(text)) return;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R30/.test(line)) continue;
    const m = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\S+)/i.exec(line);
    if (!m) continue;
    if (!/\bTO\s+(authenticated|anon|PUBLIC)\b/i.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 100), i + 5).join("\n");
    if (!/RETURN\s+v_token\b|RETURNING\s+token\b/i.test(window)) continue;
    const role = RegExp.$1;
    report(file, i + 1, "SEC-R30",
      `GRANT EXECUTE ... TO ${role} on a function whose body returns a raw token — round-30 says raw tokens never reach a non-service_role caller`);
  }
}

// Rule SEC-R13 — no service_role / raw-SQL endpoint in public app frontends
//   SECURITY.md invariant #13. Round 35; widened in round 36.
//   The /api/sql endpoint and the service-role key are server-only. A public
//   frontend that references either ships an RLS-bypass primitive to every
//   visitor — exactly the in-browser "Setup Database" wizard removed from
//   the angular shop in round 35, and the tutorial Execute button removed
//   in round 36 (examples/12-tutorial sent 'Bearer ' + PGR.serviceRoleKey
//   to PGR.apiBase + '/sql' — camelCase identifier and string-concatenated
//   URL, both invisible to the round-35 patterns and the apps/-only scope).
//
//   Scope: client bundles under apps/ AND examples/ (.html/.js/.mjs/.ts).
//   Studio (studio/, NOT under apps/) is the legitimate admin SQL console
//   and is intentionally out of scope. proxy-go is .go and excluded.
//   Comment-only lines are skipped so documentary "we deliberately do not
//   surface service_role" notes do not trip the rule.
//   Override a verified-safe occurrence with `// lint:allow=SEC-R13`.
function checkFrontendServiceRole(file, text) {
  const norm = file.replace(/\\/g, "/");
  if (!/\/(apps|examples)\//.test(norm)) return;
  if (!/\.(html|js|mjs|ts)$/.test(norm)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R13/.test(line)) continue;
    if (/^\s*(\/\/|<!--|\*|--)/.test(line)) continue; // comment-only line
    if (/\/api\/sql\b/.test(line) || /\bapiBase\s*\+\s*['"]\/sql\b/.test(line)) {
      report(file, i + 1, "SEC-R13",
        "public frontend references the raw-SQL endpoint (/api/sql, literal or concatenated) — server-only (SECURITY.md invariant 13)");
    }
    if (/service[_-]?role/i.test(line)) {
      report(file, i + 1, "SEC-R13",
        "public frontend references the service role key — service_role must never appear in a browser bundle (SECURITY.md invariant 13)");
    }
  }
}

// Rule SEC-R14 — every SECURITY DEFINER function in the extension's install
//   path must be REVOKEd from PUBLIC. Round 36.
//   PostgreSQL grants PUBLIC EXECUTE on new functions by default. A
//   SECURITY DEFINER function left PUBLIC-executable runs as the extension
//   owner for any caller — exactly the persistence-poisoning hole where the
//   0.1.4 fresh install created pgr._persist_subscription / _forget_subscription
//   (SD) but forgot to revoke them, while the upgrade script did. This rule
//   would have caught it. Scope: the default-version full-install script and
//   any upgrade script that lands on the default version (read from
//   pg_reactive.control), so superseded historical scripts are not flagged.
//   Override a verified-safe occurrence with `-- lint:allow=SEC-R14`.
function auditSDRevoke(file, text) {
  const lines = text.split(/\r?\n/);
  // Collect SECURITY DEFINER function names with their CREATE line index.
  const sdFns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/i.exec(lines[i]);
    if (!m) continue;
    // Scan the header (until the body delimiter) for SECURITY DEFINER.
    let isSD = false;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      if (/\bSECURITY\s+DEFINER\b/i.test(lines[j])) { isSD = true; }
      if (/\bAS\s+(\$|')/i.test(lines[j]) || /\bAS\s+'MODULE_PATHNAME'/i.test(lines[j])) break;
    }
    if (isSD) sdFns.push({ name: m[1], line: i + 1 });
  }
  for (const fn of sdFns) {
    if (/lint:allow=SEC-R14/.test(lines[fn.line - 1])) continue;
    const esc = fn.name.replace(/[.]/g, "\\.");
    const revoke = new RegExp(
      `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${esc}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, "i");
    if (!revoke.test(text)) {
      report(file, fn.line, "SEC-R14",
        `SECURITY DEFINER function ${fn.name} is never REVOKEd from PUBLIC — PostgreSQL grants PUBLIC EXECUTE by default, so any role runs it as the extension owner (SECURITY.md invariant 14)`);
    }
  }
}

function checkExtSDRevoke() {
  const extDir = join(ROOT, "ext");
  let ctrl;
  try { ctrl = readFileSync(join(extDir, "pg_reactive.control"), "utf-8"); } catch { return; }
  const m = /default_version\s*=\s*'([^']+)'/.exec(ctrl);
  if (!m) return;
  const ver = m[1];
  const verEsc = ver.replace(/[.]/g, "\\.");
  const targets = new Set([`pg_reactive--${ver}.sql`]);
  let names;
  try { names = readdirSync(extDir); } catch { names = []; }
  for (const n of names) {
    if (new RegExp(`^pg_reactive--[0-9.]+--${verEsc}\\.sql$`).test(n)) targets.add(n);
  }
  for (const t of targets) {
    const fp = join(extDir, t);
    let text;
    try { text = readFileSync(fp, "utf-8"); } catch { continue; }
    auditSDRevoke(fp, text);
  }
}

// Rule SEC-R37 — the WebSocket proxy audience/mode gate must read the
//   transactional pgr.subscription_meta catalog, never pgr.get_subscriptions().
//   SECURITY.md invariant #15. Audit round 37 F1 HIGH.
//   pgr.get_subscriptions() reads the non-transactional shmem hash, which
//   pgr.subscribe() mutates out-of-transaction. Sourcing the audience gate
//   from it lets a concurrent session's uncommitted (or later rolled-back)
//   re-subscribe flip an audience-bound subscription to public for the whole
//   transaction window — an audience bypass at WS-connect. pgr.subscription_meta
//   reads pgr.persisted_subscriptions (MVCC), so only committed rows are seen.
//   Scope: proxy-go/**/*.go. Matches a (non-comment) line that pulls `audience`
//   from pgr.get_subscriptions().
//   Override a verified-safe occurrence with `// lint:allow=SEC-R37`.
function checkProxyAudienceSource(file, text) {
  const norm = file.replace(/\\/g, "/");
  if (!/\/proxy-go\//.test(norm) || !/\.go$/.test(norm)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R37/.test(line)) continue;
    if (/^\s*\/\//.test(line)) continue; // comment-only line
    if (/get_subscriptions/.test(line) && /audience/i.test(line)) {
      report(file, i + 1, "SEC-R37",
        "proxy reads audience from pgr.get_subscriptions() (non-transactional shmem) — the audience gate must use pgr.subscription_meta (transactional catalog) so an uncommitted/rolled-back re-subscribe cannot leak (SECURITY.md invariant 15, round-37 F1)");
    }
  }
}

// Rule SEC-R39 — the live-query NOTIFY fan-out must re-authorize per delivery.
//   SECURITY.md invariant #16. Audit round 39 F1 HIGH.
//   Hub.Broadcast delivers to every subscriber WITHOUT re-checking the audience
//   — fine for presence, but a stale-permission hole for live-query deltas: a
//   connection authorized while a query was public keeps reading it after the
//   subscription is re-registered as private. The NOTIFY-delta path must use
//   Hub.BroadcastDelta (resolves the current audience, revokes connections that
//   no longer qualify). This flags a regression to the plain Broadcast on that
//   path. Scope: proxy-go/**/*.go.
//   Override a verified-safe occurrence with `// lint:allow=SEC-R39`.
function checkDeltaReauth(file, text) {
  const norm = file.replace(/\\/g, "/");
  if (!/\/proxy-go\//.test(norm) || !/\.go$/.test(norm)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R39/.test(line)) continue;
    if (/^\s*\/\//.test(line)) continue; // comment-only line
    if (/\.Broadcast\(\s*msg\.QueryID/.test(line)) {
      report(file, i + 1, "SEC-R39",
        "live-query delta fan-out uses Hub.Broadcast (no per-delivery re-auth) — deltas must go through Hub.BroadcastDelta so an audience change revokes stale connections (SECURITY.md invariant 16, round-39 F1)");
    }
  }
}

function runAll() {
  const files = [];
  for (const r of ROOTS) {
    walk(join(ROOT, r), files);
  }
  checkExtSDRevoke();

  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf-8"); } catch { continue; }
    checkSecurityDefiner(f, text);
    checkGrantExecuteToPublic(f, text);
    checkChiRealIPUsage(f, text);
    checkRawTokenGrant(f, text);
    checkFrontendServiceRole(f, text);
    checkProxyAudienceSource(f, text);
    checkDeltaReauth(f, text);
  }

  if (findings.length === 0) {
    console.log("OK — no unsafe patterns found.");
    process.exit(0);
  }

  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );

  console.error(`\n${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  X ${f.file}:${f.line}  [${f.ruleId}]  ${f.message}`);
  }
  console.error("\nAdd `-- lint:allow=<RULE-ID>` (or `// lint:allow=...` in Go) on the offending line to silence a verified-safe occurrence.");
  process.exit(1);
}

runAll();
