// Version inventory collector.
//
// Reads the pins that actually decide what runs — Dockerfile bases, CI
// toolchains, compose images — and returns one row per (runtime, version,
// source). No hardcoded expectations: if a version is written down somewhere
// that matters, it is collected.
//
// The comparison against upstream lives in check.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Debian codenames, because tags say `bookworm`, not `12`.
const DEBIAN_CODENAMES = { bullseye: "11", bookworm: "12", trixie: "13", forky: "14" };

// image repo (registry stripped) -> runtime + how its cycle is derived.
const RUNTIMES = [
  { id: "go", feed: "go", images: ["golang"], cycle: "minor" },
  { id: "node", feed: "nodejs", images: ["node"], cycle: "major" },
  { id: "rust", feed: "rust", images: ["rust"], cycle: "minor" },
  { id: "python", feed: "python", images: ["python"], cycle: "minor" },
  { id: "postgres", feed: "postgresql", images: ["postgres"], cycle: "major" },
  { id: "java", feed: "temurin", images: ["eclipse-temurin"], cycle: "major" },
  { id: "dotnet", feed: "dotnet", images: ["dotnet/sdk", "dotnet/runtime"], cycle: "minor" },
  { id: "debian", feed: "debian", images: ["debian"], cycle: "codename" },
  { id: "nginx", feed: "nginx", images: ["nginx"], cycle: "minor" },
];

function gitFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

// `golang:1.26.10-bookworm@sha256:... AS builder` -> { image, tag }
function parseFrom(line) {
  const m = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
  if (!m) return null;
  const ref = m[1].replace(/@sha256:[a-f0-9]+$/i, "");
  const colon = ref.lastIndexOf(":");
  if (colon === -1) return { image: ref, tag: "" };
  return { image: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

function registryStripped(image) {
  return image.replace(/^[^/]+\.[^/]+\//, "");
}

function numericPart(tag) {
  const m = tag.match(/^v?(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

function cycleOf(runtime, version, tag) {
  if (!runtime) return null;
  if (runtime.cycle === "codename") {
    for (const [name, n] of Object.entries(DEBIAN_CODENAMES)) {
      if (tag.includes(name)) return n;
    }
    return null;
  }
  if (!version) return null;
  const parts = version.split(".");
  if (runtime.cycle === "major") return parts[0];
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0];
}

function classify(image, tag) {
  const repo = registryStripped(image);
  const runtime = RUNTIMES.find((r) => r.images.includes(repo));
  if (!runtime) return null;
  const version = numericPart(tag);
  return { id: runtime.id, feed: runtime.feed, version, cycle: cycleOf(runtime, version, tag) };
}

export function collect() {
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    const key = `${row.id}|${row.version ?? "?"}|${row.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const file of gitFiles()) {
    const base = path.basename(file);

    if (base.startsWith("Dockerfile")) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const line of text.split("\n")) {
        const parsed = parseFrom(line);
        if (!parsed) continue;
        const hit = classify(parsed.image, parsed.tag);
        if (hit) push({ ...hit, source: file, kind: "dockerfile" });
      }
      continue;
    }

    if (/^docker-compose.*\.ya?ml$/.test(base) || /^compose.*\.ya?ml$/.test(base)) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*image:\s*["']?([^"'\s#]+)["']?/);
        if (!m) continue;
        const ref = m[1].replace(/@sha256:[a-f0-9]+$/i, "");
        const colon = ref.lastIndexOf(":");
        const image = colon === -1 ? ref : ref.slice(0, colon);
        const tag = colon === -1 ? "" : ref.slice(colon + 1);
        const hit = classify(image, tag);
        if (hit) push({ ...hit, source: file, kind: "compose" });
      }
      continue;
    }

    if (file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file)) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      const grab = (re, id, feed, cycle) => {
        for (const m of text.matchAll(re)) {
          const version = m[1];
          push({ id, feed, version, cycle: cycleOf({ cycle }, version, ""), source: file, kind: "ci" });
        }
      };
      grab(/\bnode-version:\s*"([^"]+)"/g, "node", "nodejs", "major");
      grab(/\bgo-version:\s*"([^"]+)"/g, "go", "go", "minor");
      // rustup toolchain pin in ci.yml (actions-rust-lang/setup-rust-toolchain)
      grab(/\btoolchain:\s*"([0-9][^"]*)"/g, "rust", "rust", "minor");
    }
  }

  rows.sort((a, b) => a.id.localeCompare(b.id) || cmpVersion(a.version, b.version) || a.source.localeCompare(b.source));
  return rows;
}

function cmpVersion(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function renderTable(rows) {
  const lines = [
    "| Runtime | Version | Cycle | Source |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.version ?? "—"} | ${r.cycle ?? "—"} | ${r.source} |`),
  ];
  return lines.join("\n");
}

export { ROOT, cmpVersion, parseFrom, classify, cycleOf };
