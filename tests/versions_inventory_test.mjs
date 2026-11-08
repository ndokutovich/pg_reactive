// Execution tests for the version inventory (scripts/versions/).
//
// The collector is what decides whether the committed docs/VERSIONS.md can be
// trusted, so it is tested by running it against this tree — not by grepping
// its source. The snapshot gate itself is exercised as a subprocess: it must
// exit 0 on a clean checkout and non-zero on a drifted document.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { collect, renderTable, parseFrom, classify, cycleOf } from "../scripts/versions/inventory.mjs";
import { judge, summarize, validateRules } from "../scripts/versions/judge.mjs";

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`); if (!cond) fail++; };
const run = (args) => {
  try { return { code: 0, out: execFileSync("node", ["scripts/versions/check.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { code: e.status ?? 1, out: ((e.stdout || "") + (e.stderr || "")).trim() }; }
};

console.log("=== version inventory ===");

// ── parsing ──────────────────────────────────────────────────────────────────
const ref = parseFrom("FROM golang:1.26.10-bookworm@sha256:abc123 AS builder");
ok(ref?.image === "golang" && ref?.tag === "1.26.10-bookworm", "FROM strips the digest and the AS alias");
ok(parseFrom("FROM node:20-bookworm-slim")?.tag === "20-bookworm-slim", "FROM parses a suffixed tag");
ok(parseFrom("RUN echo FROM nope") === null, "only real FROM lines are parsed");

const go = classify("golang", "1.26.10-bookworm");
ok(go?.id === "go" && go?.cycle === "1.26", "go cycle is major.minor");
const node = classify("node", "20-bookworm-slim");
ok(node?.id === "node" && node?.cycle === "20", "node cycle is the major");
const pg = classify("postgres", "16-bookworm");
ok(pg?.id === "postgres" && pg?.cycle === "16" && pg?.version === "16", "postgres cycle is the major");
const deb = classify("debian", "bookworm-slim");
ok(deb?.id === "debian" && deb?.cycle === "12", "debian codename maps to a cycle");
ok(classify("gcr.io/distroless/static-debian12", "nonroot") === null, "unknown images are not classified");
ok(cycleOf({ cycle: "minor" }, "3.12.16", "3.12-slim") === "3.12", "python cycle is major.minor");
ok(cycleOf({ cycle: "major" }, "8.0", "8.0") === "8", "dotnet cycle is the major, matching the feed's keys");

// ── judgement: precision, EOL, and the NaN trap ──────────────────────────────
const feed = (cycle, latest, eol = false) => new Map([["nodejs", [{ cycle, latest, eol }]]]);
const rulesWith = (floor) => ({ runtimes: { nodejs: { 24: floor } } });
const row24 = { id: "node", feed: "nodejs", cycle: "24", version: "24" };
const at = (version, opts = {}) => ({ ...row24, version, ...opts });

ok(judge(row24, { feeds: feed("24", "24.22.2"), rules: {}, today: "2026-11-08" }).state === "floating",
  "a major-only pin is floating, not stale (precision rule)");
ok(judge(at("24.22.0"), { feeds: feed("24", "24.22.2"), rules: {}, today: "2026-11-08" }).state === "stale",
  "a full pin behind the latest patch is stale");
ok(judge(at("24.22.2"), { feeds: feed("24", "24.22.2"), rules: {}, today: "2026-11-08" }).state === "ok",
  "the latest patch is ok");
ok(judge(at("20", { cycle: "20" }), { feeds: feed("20", "20.19.0", "2026-04-30"), rules: {}, today: "2026-11-08" }).state === "eol",
  "a branch dead in the feed is eol");
ok(judge(row24, { feeds: new Map(), rules: rulesWith("eol"), today: "2026-11-08" }).state === "eol",
  "an eol floor wins even when the feed is unavailable");
ok(judge(row24, { feeds: feed("24", "24.22.2"), rules: rulesWith("24.22.1"), today: "2026-11-08" }).state === "floating",
  "a major-only pin against a full CVE floor is floating, not stale");
ok(judge(at("24.22.0"), { feeds: feed("24", "24.22.2"), rules: rulesWith("24.22.1"), today: "2026-11-08" }).state === "stale",
  "a full pin below the CVE floor is stale");
ok(judge(row24, { feeds: feed("25", "25.0.0"), rules: {}, today: "2026-11-08" }).state === "unknown",
  "a cycle the feed does not know is unknown, never ok");
const badRules = validateRules({ runtimes: { nodejs: { 24: "latest" } } });
ok(badRules.length === 1 && /neither/.test(badRules[0]),
  "an invalid CVE floor is rejected instead of being compared as NaN");
ok(validateRules(null).length === 1, "a degenerate rules file is rejected, not read as 'no rules'");
ok(validateRules({ runtimes: [] }).length === 1, "a non-object runtimes section is rejected");
ok(validateRules({ runtimes: { nodejs: { 20: "eol", 24: "24.22.1" } } }).length === 0, "a well-formed rules file passes");

// ── summary: silence is never green ─────────────────────────────────────────
const s = (states, opts = {}) => summarize(states.map((state) => ({ state })), opts);
ok(s(["unknown"], { strict: false }).fatal.length === 0, "an unjudged pin is only a warning without --strict");
ok(s(["unknown"], { strict: true }).fatal.length === 1, "an unjudged pin fails the strict run");
ok(s([], { feedFailures: 1, strict: true }).fatal.length === 1, "an unavailable feed fails the strict run");
ok(s(["eol"], { strict: false }).fatal.length === 1, "a dead branch is fatal without --strict");
ok(s(["stale"], { strict: false }).fatal.length === 0, "a stale patch is only a warning without --strict");
ok(s(["stale"], { strict: true }).fatal.length === 1, "a stale patch fails the strict run");

// ── collection against this tree ─────────────────────────────────────────────
const rows = collect();
ok(rows.length > 20, `collector found ${rows.length} pins`);
ok(rows.some((r) => r.id === "go" && r.version === "1.26.10"), "go 1.26.10 is collected");
ok(rows.some((r) => r.id === "node" && r.version === "24"), "node 24 is collected");
ok(rows.some((r) => r.id === "postgres" && r.cycle === "16" && r.source.includes("docker-compose")), "compose postgres pin is collected");
ok(rows.every((r) => r.id && r.source), "every row carries a runtime and a source");
ok(!rows.some((r) => r.source.includes("node_modules")), "no rows from ignored trees");
ok(new Set(rows.map((r) => `${r.id}|${r.version}|${r.source}`)).size === rows.length, "rows are deduplicated");

const table = renderTable(rows);
ok(table.startsWith("| Runtime | Version | Cycle | Source |"), "table has the expected header");
ok(table.split("\n").length === rows.length + 2, "one table row per pin");

// ── snapshot gate: clean tree passes, drift fails ────────────────────────────
const clean = run(["--offline"]);
ok(clean.code === 0, `check --offline exits 0 on a clean tree${clean.code ? `: ${clean.out.split("\n").pop()}` : ""}`);

const DOC = join(process.cwd(), "docs", "VERSIONS.md");
const backup = DOC + ".bak";
copyFileSync(DOC, backup);
try {
  writeFileSync(DOC, readFileSync(DOC, "utf8").replace(/\| go \| 1\.26\.10 \|/, "| go | 9.9.9 |"));
  const drifted = run(["--offline"]);
  ok(drifted.code !== 0, "check --offline fails when the document drifts from the tree");
  ok(/drifted/.test(drifted.out), "the failure names the drift");
} finally {
  copyFileSync(backup, DOC);
  rmSync(backup);
}

console.log(fail ? `\n${fail} failed` : "\n✓ version inventory holds");
process.exit(fail ? 1 : 0);
