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
    checkRestoreNotDefiner(fp, text);
  }
}

// Rule SEC-R41 — pgr.restore_subscriptions() must be SECURITY INVOKER, never
//   SECURITY DEFINER. SECURITY.md invariant 18 / gemini audit P1 CRITICAL.
//   restore_subscriptions runs at every restart, invoked by the boot entrypoint
//   as the superuser, and re-executes each persisted subscription's stored query
//   (snapshot CREATE TABLE AS) under the registrant's saved search_path. To stop
//   a subscription registered with an attacker-controlled search_path from
//   escalating, it drops to the owner_role with SET LOCAL ROLE — which Postgres
//   FORBIDS inside a SECURITY DEFINER function. So SECURITY DEFINER here means
//   the privilege drop is absent and the function runs arbitrary stored SQL as
//   the superuser. Scope: the extension's landing/full-install scripts.
//   Override a verified-safe occurrence with `-- lint:allow=SEC-R41`.
function checkRestoreNotDefiner(file, text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+pgr\.restore_subscriptions\b/i.test(lines[i])) continue;
    if (/lint:allow=SEC-R41/.test(lines[i])) continue;
    // Walk the function header up to the body delimiter (AS $...$).
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      if (/\bAS\s+\$/i.test(lines[j])) break;
      if (/SECURITY\s+DEFINER/i.test(lines[j])) {
        report(file, j + 1, "SEC-R41",
          "pgr.restore_subscriptions is SECURITY DEFINER — it re-executes each subscription's stored query at restart as the extension-owning superuser; it must be SECURITY INVOKER and SET LOCAL ROLE to each owner_role (SET ROLE is forbidden in SECURITY DEFINER), or a restart escalates an attacker-registered subscription (SECURITY.md invariant 18, gemini audit P1)");
        break;
      }
    }
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

// Rule SEC-R39 — the WebSocket fan-out must stay generation-aware; a
//   generation-blind broadcast is forbidden.
//   SECURITY.md invariants #16 and #17. Audit round 39 batch-2 F1/F2 HIGH.
//   The generation model (ext 0.1.6) binds each connection to the subscription
//   generation it authorized against, and the extension stamps that generation
//   into every NOTIFY. The ONLY valid fan-out method is Hub.BroadcastGen, which
//   delivers a message only to subscribers whose generation EXACTLY matches —
//   used for live-query deltas (gen from the NOTIFY payload) and presence/client
//   broadcast (gen from the sender). A bare Hub.Broadcast — the generation-blind
//   method this fix removed — would deliver a new epoch's data to a stale socket
//   that a metadata change should have disconnected (F1/F-ORDER for deltas, F2
//   for presence/broadcast). This flags any reintroduced bare `Broadcast(` (call
//   or method definition); BroadcastGen is intentionally not matched. Scope:
//   proxy-go/**/*.go.
//   Override a verified-safe occurrence with `// lint:allow=SEC-R39`.
function checkDeltaReauth(file, text) {
  const norm = file.replace(/\\/g, "/");
  if (!/\/proxy-go\//.test(norm) || !/\.go$/.test(norm)) return;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R39/.test(line)) continue;
    if (/^\s*\/\//.test(line)) continue; // comment-only line
    // `.Broadcast(` (call) or `) Broadcast(` (method def) — but NOT
    // `.BroadcastDelta(` / `.BroadcastGen(`, which have chars before the paren.
    if (/[.)]\s*Broadcast\(/.test(line)) {
      report(file, i + 1, "SEC-R39",
        "generation-blind Hub.Broadcast on the WebSocket fan-out — deltas must use Hub.BroadcastDelta (revoke-aware) and presence/broadcast must use Hub.BroadcastGen (generation-gated) so a metadata change disconnects stale connections (SECURITY.md invariants 16-17, round-39 batch-2 F1/F2)");
    }
  }
}

// Rule SEC-R42 — the pgStack proxy must not connect to PostgreSQL as the
//   superuser in production deployment configs. SECURITY.md invariant #22 /
//   gemini audit P2.
//   The proxy connects as the powerless `authenticator` role (NOSUPERUSER,
//   NOINHERIT) and SET ROLEs per request, so a compromise cannot bypass RLS by
//   default, COPY ... FROM PROGRAM, DROP DATABASE, or read pg_authid. A
//   production DATABASE_URL pointed at the `postgres` superuser — or
//   ${POSTGRES_USER}/${PGUSER}, conventionally the superuser — re-opens all of
//   that. Scope: the production deployment configs only. The dev compose's Rust
//   *reference* proxy and the bench stack are not production and are out of
//   scope (they are not in this fixed target list). The all-in-one's documented
//   standalone-pg_reactive fallback DSN is marked lint:allow=SEC-R42.
//   Override a verified-safe occurrence with `# lint:allow=SEC-R42`.
function checkProxyNotSuperuser() {
  const targets = [
    join(ROOT, "docker-compose.prod.yml"),
    join(ROOT, "examples", "docker-compose.prod.yml"),
    join(ROOT, "docker", "all-in-one-entrypoint.sh"),
  ];
  const deployTpl = [];
  walk(join(ROOT, "deploy", "templates"), deployTpl);
  for (const f of deployTpl) if (/docker-compose\.ya?ml$/.test(f)) targets.push(f);

  // A DATABASE_URL whose role component is the conventional superuser.
  const superuserDSN =
    /DATABASE_URL.*:\/\/(?:postgres:|\$\{POSTGRES_USER|\$\{PGUSER\b|\$PGUSER\b)/;
  for (const fp of targets) {
    let text;
    try { text = readFileSync(fp, "utf-8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/lint:allow=SEC-R42/.test(line)) continue;
      if (/^\s*(?:#|--|\/\/)/.test(line)) continue; // comment-only line
      if (superuserDSN.test(line)) {
        report(fp, i + 1, "SEC-R42",
          "production proxy DATABASE_URL connects as the PostgreSQL superuser — the proxy must connect as the powerless `authenticator` role (or a per-app non-superuser) and SET ROLE per request, else a compromise bypasses RLS / runs COPY ... FROM PROGRAM / reads pg_authid (SECURITY.md invariant 22, gemini audit P2)");
      }
    }
  }
}

// Rule SEC-R43 — a bootstrap GRANT to a proxy LOGIN role must be plain.
//   SECURITY.md invariant #24 / gemini audit R8. The runtime verifyPoolRoles
//   check (proxy-go/main.go) rejects a login role whose membership edge carries
//   WITH ADMIN OPTION / INHERIT TRUE / SET FALSE; this rule catches the
//   self-inflicted version of that mistake — such an option added to a GRANT of
//   anon / authenticated / service_role TO authenticator / authenticator_admin in
//   our own SQL (init.sql, migrations, cli bootstrap). On PG16 INHERIT/SET are
//   per-membership, so an unsafe edge re-introduces ambient privilege (despite
//   the role's NOINHERIT attribute) or role delegation. The runtime check still
//   covers external/attacker DSNs this static rule cannot see.
//   Override a verified-safe occurrence with `-- lint:allow=SEC-R43`.
function checkProxyRoleGrantOptions(file, text) {
  if (!/\.sql$/.test(file)) return;
  const lines = text.split(/\r?\n/);
  const re =
    /\bGRANT\b.*\b(?:anon|authenticated|service_role)\b.*\bTO\b.*\b(?:authenticator|authenticator_admin)\b.*\bWITH\b.*(?:ADMIN\s+OPTION|INHERIT\s+TRUE|SET\s+FALSE)/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/lint:allow=SEC-R43/.test(line)) continue;
    if (/^\s*--/.test(line)) continue; // comment-only line
    if (re.test(line)) {
      report(file, i + 1, "SEC-R43",
        "a GRANT to a proxy login role (authenticator/authenticator_admin) carries an unsafe membership option (WITH ADMIN OPTION / INHERIT TRUE / SET FALSE) — proxy-role grants must be plain so privileges need an explicit SET ROLE, cannot be re-delegated, and can be assumed (SECURITY.md invariant 24, gemini audit R8; verifyPoolRoles rejects it at startup)");
    }
  }
}

function runAll() {
  const files = [];
  for (const r of ROOTS) {
    walk(join(ROOT, r), files);
  }
  checkExtSDRevoke();
  checkProxyNotSuperuser();

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
    checkProxyRoleGrantOptions(f, text);
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
