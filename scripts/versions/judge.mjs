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
  // A degenerate file must not read as "no rules, therefore nothing to check".
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return ["rules.json must be a JSON object"];
  }
  if (rules.runtimes !== undefined && (typeof rules.runtimes !== "object" || Array.isArray(rules.runtimes))) {
    return ["rules.json: runtimes must be an object of { product: { cycle: floor } }"];
  }
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

// Silence is never green. A run that could not fetch a feed, or met a pin the
// feed cannot judge, has not checked anything about those pins — in strict mode
// that is a failure, not a quiet pass. Without strict (the per-push snapshot
// job) they stay warnings, because neither is caused by the change under test.
export function summarize(judged, { feedFailures = 0, strict = false } = {}) {
  const count = (state) => judged.filter((r) => r.state === state).length;
  const fatal = [];
  const warnings = [];
  const flag = (n, msg, always = false) => {
    if (!n) return;
    if (always || strict) fatal.push(msg);
    else warnings.push(msg);
  };

  // A dead branch is a fact about upstream, not about the change under test:
  // it fails every run, strict or not.
  flag(count("eol"), `${count("eol")} pin(s) on a dead branch — no patch is coming`, true);
  flag(count("stale"), `${count("stale")} pin(s) behind the latest patch of a live branch`);
  flag(count("unknown"), `${count("unknown")} pin(s) the feed cannot judge — silence is not green`);
  flag(feedFailures, `${feedFailures} feed(s) unavailable — freshness is incomplete`);

  return { fatal, warnings };
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
