// Pure judgement: one pin + the feeds -> one state. No I/O, no network, so
// every edge case is unit-testable without mocking a registry.
//
// Order matters:
//   1. a hand-declared dead branch wins over everything — no patch is coming;
//   2. a CVE floor is enforced BEFORE the feed, because a bulletin must hold
//      even when the network is down;
//   3. the feed answers what the rules cannot.
//
// States: ok | stale | eol | floating | unknown. `floating` is not a pass — it
// says the patch level is chosen by the registry, not by us, so a claim about
// "latest patch" cannot be made either way.

import { cmpVersion, normalizeVersion, versionParts } from "./versions.mjs";

export function validateRules(rules) {
  const errors = [];
  for (const [product, cycles] of Object.entries(rules.runtimes ?? {})) {
    for (const [cycle, floor] of Object.entries(cycles)) {
      if (floor === "eol") continue;
      if (!normalizeVersion(floor)) {
        errors.push(`${product}/${cycle}: ${JSON.stringify(floor)} is neither "eol" nor a version`);
      }
    }
  }
  return errors;
}

export function judge(row, { feeds, rules, today }) {
  const floor = rules.runtimes?.[row.feed]?.[row.cycle];

  if (floor === "eol") {
    return { state: "eol", note: "rules.json marks the branch dead" };
  }

  if (!row.version) {
    return { state: "floating", note: "only a moving tag is pinned" };
  }

  if (floor) {
    const f = normalizeVersion(floor);
    if (versionParts(row.version) < versionParts(f)) {
      return { state: "floating", note: `CVE floor ${f} — pin a full version to assert` };
    }
    if (cmpVersion(row.version, f) < 0) {
      return { state: "stale", note: `below CVE floor ${f}` };
    }
  }

  const entries = feeds.get(row.feed);
  if (!entries) return { state: "unknown", note: "feed unavailable" };

  const entry = entries.find((e) => String(e.cycle) === String(row.cycle));
  if (!entry) return { state: "unknown", note: `feed has no cycle ${row.cycle}` };

  const dead = entry.eol === true || (typeof entry.eol === "string" && entry.eol <= today);
  if (dead) return { state: "eol", note: `EOL ${entry.eol}` };

  const latest = normalizeVersion(entry.latest);
  if (!latest) return { state: "unknown", note: `feed latest ${JSON.stringify(entry.latest)} is not a version` };

  if (versionParts(row.version) < versionParts(latest)) {
    return { state: "floating", note: `latest patch ${latest} — pin a full version to assert` };
  }
  if (cmpVersion(row.version, latest) < 0) {
    return { state: "stale", note: `latest ${latest}` };
  }
  return { state: "ok", note: latest };
}
