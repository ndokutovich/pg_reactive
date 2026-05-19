#!/usr/bin/env node
// Doc-test harness — round 31 Tier 1.2 from the SECURITY.md ritual.
//
// Walks every ```sql fenced block in docs/site/docs/**/*.md, executes
// it against an isolated PostgreSQL test database, and fails if PG
// rejects it. This catches the class of regression that hit us
// repeatedly in audit rounds: docs teaching a SECURITY DEFINER that
// can't actually be CREATEd as written (wrong RETURNS, mismatched
// schema, missing CREATE EXTENSION dep), or a GRANT line that
// references a non-existent function signature, or a CREATE TABLE
// without the schema the surrounding helpers write to.
//
// Run:
//   docker compose up -d                              # PG must be live
//   node tests/doc_sql_smoke_test.mjs
//
// Skip individual blocks that are deliberately non-executable
// (illustration-only, "footgun" examples) with the per-block
// directive comment:
//   ```sql  doc-test:skip=<reason>
//   ...
//   ```

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
// We use execFile (no shell) — never use the shell-invoking variant
// here; doc bodies are untrusted input even though they come from
// the repo (a malicious PR could otherwise inject commands).
import { execFileSync as runProc } from "node:child_process";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const DOCS_ROOT = `${REPO}/docs/site/docs`;

// Skip suffixes that are intentionally narrative-only (config snippets,
// nginx, JSON examples, output samples). We only execute SQL.
const RUNNERS = new Set(["sql", "postgresql", "postgres", "psql"]);

// Heuristic skip-list: blocks that mention objects we don't ship in
// the smoke fixture. They're fine to read, just not fine to run as-is
// without the surrounding application. Each entry is a substring that
// causes the block to be skipped — keep narrow, prefer per-block
// `doc-test:skip=` directives in the doc itself.
const HEURISTIC_SKIPS = [
  // DBOS example references dbos.job_queue which is part of the
  // user's application, not the bootstrap.
  "INSERT INTO dbos.job_queue",
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, acc);
    } else if (name.endsWith(".md") || name.endsWith(".mdx")) {
      acc.push(p);
    }
  }
  return acc;
}

// extractSqlBlocks returns [{ runner, code, skipReason, line }] for
// the file. line = 1-based start line of the block opening fence.
function extractSqlBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let inBlock = null;
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock === null) {
      const m = /^```([a-z][a-z0-9+-]*)(.*)$/i.exec(line);
      if (m) {
        const runner = m[1].toLowerCase();
        const extras = m[2] || "";
        const skipDirective = /\bdoc-test:skip=([^\s]+)/.exec(extras);
        inBlock = {
          runner,
          line: i + 1,
          skipReason: skipDirective ? skipDirective[1] : null,
        };
        buf = [];
      }
    } else if (/^```\s*$/.test(line)) {
      inBlock.code = buf.join("\n");
      blocks.push(inBlock);
      inBlock = null;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  return blocks;
}

function shouldRun(block) {
  if (block.skipReason) return [false, `skip directive: ${block.skipReason}`];
  if (!RUNNERS.has(block.runner)) return [false, `runner=${block.runner}`];
  if (block.code.trim().length === 0) return [false, "empty block"];
  for (const needle of HEURISTIC_SKIPS) {
    if (block.code.includes(needle)) {
      return [false, `heuristic skip: ${needle}`];
    }
  }
  return [true, null];
}

function psqlExec(sql) {
  // Isolated test schema per block — DROP + CREATE so leaks across
  // blocks can't mask broken dependencies. The user's docs assume
  // CREATE EXTENSION / schemas exist, so we pre-load pg_reactive and
  // pgstack into the test schema's search_path.
  const wrapped = `
    SET client_min_messages TO WARNING;
    DROP SCHEMA IF EXISTS doctest CASCADE;
    CREATE SCHEMA doctest;
    SET search_path TO doctest, public, pg_catalog;
    -- Block body follows. The doc author is expected to write
    -- standalone-runnable SQL OR mark the block doc-test:skip=...
    ${sql}
  `;
  // docker compose so we hit the test DB the rest of the e2e suite
  // uses; the user's local environment already has it up.
  runProc(
    "docker",
    [
      "compose", "exec", "-T", "db",
      "psql", "-U", "postgres", "-d", "pg_reactive_test",
      "-v", "ON_ERROR_STOP=1",
      "-c", wrapped,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function main() {
  let total = 0;
  let executed = 0;
  let skipped = 0;
  const failures = [];

  const files = walk(DOCS_ROOT).sort();
  for (const f of files) {
    const blocks = extractSqlBlocks(readFileSync(f, "utf-8"));
    for (const b of blocks) {
      total++;
      const [run] = shouldRun(b);
      if (!run) {
        skipped++;
        continue;
      }
      executed++;
      try {
        psqlExec(b.code);
        process.stdout.write(".");
      } catch (e) {
        process.stdout.write("F");
        failures.push({
          file: relative(REPO, f),
          line: b.line,
          err: (e.stderr?.toString?.() || e.message || String(e)).trim(),
        });
      }
    }
  }
  process.stdout.write("\n");

  console.log(
    `\nDoc-SQL smoke: ${executed}/${total} blocks executed ` +
    `(${skipped} skipped: non-SQL runner / explicit skip / heuristic).`,
  );

  if (failures.length === 0) {
    console.log("OK — every executed SQL block parsed and ran cleanly.");
    process.exit(0);
  }

  console.error(`\n${failures.length} block(s) failed:\n`);
  for (const f of failures) {
    console.error(`✗ ${f.file}:${f.line}`);
    console.error(`  ${f.err.split("\n").map((l) => "  " + l).join("\n")}`);
    console.error();
  }
  process.exit(1);
}

main();
