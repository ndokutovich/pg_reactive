// Version primitives. Everything that compares versions goes through here so
// the precision rule and the NaN trap live in one place.
//
// Precision rule: a comparison is only meaningful at the precision the pin
// NAMED. `24` against `24.22.2` proves nothing — the registry resolves the
// floating tag — so callers check `versionParts` first. This is the bug class
// that made a sibling inventory report 114 false "stale" flags.
//
// NaN trap: `NaN < 0` is false. Any comparison fed a non-version silently
// reports "fine". normalizeVersion() returns null instead, and cmpVersion
// throws — a gate must never read silence as green.

export function normalizeVersion(v) {
  if (typeof v !== "string") return null;
  // Build metadata (`21.0.13+9`) and distro suffixes (`3.12-slim`) are not
  // part of the version.
  const m = v.trim().match(/^v?(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

export function versionParts(v) {
  const n = normalizeVersion(v);
  return n ? n.split(".").length : 0;
}

export function cmpVersion(a, b) {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (!na || !nb) throw new Error(`cmpVersion: not a version: ${JSON.stringify(!na ? a : b)}`);
  const pa = na.split(".").map(Number);
  const pb = nb.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
