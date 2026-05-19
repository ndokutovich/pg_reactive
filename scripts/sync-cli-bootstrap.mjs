#!/usr/bin/env node
// Extracts the BEGIN-PGSTACK-CORE / END-PGSTACK-CORE region from
// docker/init.sql (the SoT for the security-critical bootstrap
// backbone) and writes it to cli/templates/bootstrap-core.sql
// (what the CLI ships to npm and what `pgstack init` lays into
// the user's first migration).
//
// CI runs this script and then `git diff --exit-code` on the
// template. A drift means an audit-relevant change was made to
// docker/init.sql but not propagated, which would silently regress
// the CLI back into the round-12 / round-28 footguns.
//
// Run:  node scripts/sync-cli-bootstrap.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "docker", "init.sql");
const DST = resolve(ROOT, "cli", "templates", "bootstrap-core.sql");

const BEGIN = "-- BEGIN-PGSTACK-CORE";
const END = "-- END-PGSTACK-CORE";

function extractCoreRegion(text) {
  const beginIdx = text.indexOf(BEGIN);
  const endIdx = text.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(
      `docker/init.sql is missing the ${BEGIN} / ${END} sentinel markers; ` +
      `cannot extract the CLI core. See round-31 Tier 2.3 in SECURITY.md.`,
    );
  }
  // Take everything from the line AFTER the BEGIN marker up to
  // (but not including) the line containing the END marker.
  const afterBegin = text.indexOf("\n", beginIdx) + 1;
  // Walk back from endIdx to the newline that starts that line.
  const beforeEnd = text.lastIndexOf("\n", endIdx - 1) + 1;
  return text.slice(afterBegin, beforeEnd).trimEnd() + "\n";
}

function header() {
  return [
    "-- ───────────────────────────────────────────────────────────────────────────",
    "-- GENERATED FILE — DO NOT EDIT BY HAND.",
    "--",
    "-- Source of truth: docker/init.sql, region between",
    "--   -- BEGIN-PGSTACK-CORE / -- END-PGSTACK-CORE",
    "-- Sync:           node scripts/sync-cli-bootstrap.mjs",
    "-- CI parity:      .github/workflows/ci.yml \"cli/templates/bootstrap-core.sql parity\"",
    "--",
    "-- This file is the security-critical bootstrap backbone the CLI",
    "-- emits when a user runs `pgstack init`. It contains roles, schemas,",
    "-- auth tables, RLS, and the default-deny grants for `public`. Demo",
    "-- tables and dev fixtures stay in docker/init.sql and do NOT ship",
    "-- in the CLI bootstrap — those are the operator's job to add via",
    "-- their own migrations.",
    "-- ───────────────────────────────────────────────────────────────────────────",
    "",
    "",
  ].join("\n");
}

function main() {
  const src = readFileSync(SRC, "utf-8");
  const core = extractCoreRegion(src);
  mkdirSync(dirname(DST), { recursive: true });
  writeFileSync(DST, header() + core);
  console.log(`Synced ${DST.replace(ROOT + "/", "")} ← ${SRC.replace(ROOT + "/", "")}`);
  console.log(`  ${core.split("\n").length} lines of SQL.`);
}

main();
