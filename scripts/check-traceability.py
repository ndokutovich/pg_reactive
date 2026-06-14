#!/usr/bin/env python3
"""Traceability gate (universal — from the `project-trace` skill).

Parses the matrix at ``docs/traceability.yaml`` and:

* prints status counts + test-bucket coverage
* fails if any requirement's status regressed vs the baseline in
  ``docs/traceability.baseline.json``
* fails if any requirement from the baseline is missing from the matrix
* refreshes the baseline when run with ``--write-baseline`` (manual gate
  bump after a deliberate downgrade)

Config (FR id pattern, status ranks, test buckets) is read from comment
lines at the top of the matrix YAML — see the matrix header.

Designed to run in CI without external Python deps.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATRIX = ROOT / "docs" / "traceability.yaml"
BASELINE = ROOT / "docs" / "traceability.baseline.json"

# Defaults — overridden by `# key: value` lines in the matrix header.
DEFAULTS = {
    "fr_pattern": r"^([A-Z]+-[A-Za-z0-9_.]+):$",
    "status_ranks": "implemented:3,partial:2,not_implemented:1",
    "test_buckets": "unit,ui,e2e,manual",
    # Empty → single-status mode (legacy).
    # Comma-list (e.g. "frontend,backend,test") → multi-dim mode: each FR's
    # status: line is followed by indented `<dim>: <rank-name>` pairs, and
    # the gate compares each dimension against the baseline independently.
    "status_dimensions": "",
}

# Header keys we recognise (any unknown key is ignored).
HEADER_KEYS = set(DEFAULTS.keys())

_STATUS_INLINE_RE = re.compile(r"^  status:\s*(\S.*)$")
_STATUS_BLOCK_RE = re.compile(r"^  status:\s*$")
_STATUS_DIM_RE = re.compile(r"^    ([a-z_]+):\s*(\S+)\s*$")
_TESTS_RE = re.compile(r"^  tests:\s*$")
_TRACES_RE = re.compile(r"^  traces:\s*$")
_LIST_FILE_RE = re.compile(r"^\s+-\s+file:\s*(.+)$")
_HEADER_KV_RE = re.compile(r"^#\s*([a-z_]+):\s*(.+?)\s*$")


def read_config(text: str) -> dict[str, str]:
    """Parse `# key: value` lines from the matrix header into a config dict."""
    cfg = dict(DEFAULTS)
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line.startswith("#"):
            # First non-comment line ends the header.
            if line.strip():
                break
            continue
        m = _HEADER_KV_RE.match(line)
        if m and m.group(1) in HEADER_KEYS:
            cfg[m.group(1)] = m.group(2)
    return cfg


def parse_status_ranks(value: str) -> dict[str, int]:
    """`implemented:3,partial:2,not_implemented:1` → {name: rank}."""
    out: dict[str, int] = {}
    for token in value.split(","):
        token = token.strip()
        if not token:
            continue
        name, _, rank = token.partition(":")
        try:
            out[name.strip()] = int(rank.strip())
        except ValueError:
            continue
    if not out:
        raise SystemExit(f"invalid status_ranks: {value!r}")
    return out


def parse_matrix(
    text: str,
    fr_re: re.Pattern[str],
    buckets: list[str],
    dimensions: list[str],
) -> dict[str, dict]:
    """Parse the matrix. Supports both single-status and multi-dim modes.

    Single-dim:  `  status: <name>`
    Multi-dim:   `  status:` followed by `    <dim>: <name>` lines for each
                 configured dimension.

    In multi-dim mode each FR's `status` field is a dict {dim: name}.
    In single-dim mode it's a plain string.
    """
    frs: dict[str, dict] = {}
    cur: dict | None = None
    block: str | None = None
    bucket: str | None = None
    in_status_block = False
    bucket_re = re.compile(rf"^    ({'|'.join(re.escape(b) for b in buckets)}):\s*(.*)$")
    default_status = next(iter(STATUS_RANKS_GLOBAL))
    multi = bool(dimensions)
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if line.lstrip().startswith("#") or not line.strip():
            continue
        m = fr_re.match(line)
        if m:
            if cur is not None:
                frs[cur["id"]] = cur
            cur = {
                "id": m.group(1),
                "status": ({d: default_status for d in dimensions} if multi else default_status),
                "tests": {b: [] for b in buckets},
                "traces": [],
            }
            block = None
            bucket = None
            in_status_block = False
            continue
        if cur is None:
            continue
        # Inline status (single-dim) — captured even in multi-dim mode for
        # backward compatibility / mixed matrices.
        m = _STATUS_INLINE_RE.match(line)
        if m:
            if multi:
                # Treat inline value as the frontend dimension only — caller
                # can detect under-specification via summary.
                cur["status"][dimensions[0]] = m.group(1).strip()
            else:
                cur["status"] = m.group(1).strip()
            block = None
            bucket = None
            in_status_block = False
            continue
        # Block status (multi-dim): `  status:` then indented dim:value pairs.
        if _STATUS_BLOCK_RE.match(line):
            in_status_block = True
            block = None
            bucket = None
            continue
        if in_status_block:
            dim_m = _STATUS_DIM_RE.match(line)
            if dim_m:
                name = dim_m.group(1)
                value = dim_m.group(2)
                if multi and name in dimensions:
                    cur["status"][name] = value
                continue
            # Any other line shape ends the status block — fall through.
            in_status_block = False
        if _TRACES_RE.match(line):
            block = "traces"
            bucket = None
            continue
        if _TESTS_RE.match(line):
            block = "tests"
            bucket = None
            continue
        if block == "tests":
            m = bucket_re.match(line)
            if m:
                bucket = m.group(1)
                continue
        m = _LIST_FILE_RE.match(line)
        if m:
            if block == "traces":
                cur["traces"].append(m.group(1).strip())
            elif block == "tests" and bucket:
                cur["tests"][bucket].append(m.group(1).strip())
    if cur is not None:
        frs[cur["id"]] = cur
    return frs


def print_summary(
    frs: dict[str, dict],
    status_ranks: dict[str, int],
    buckets: list[str],
    dimensions: list[str],
) -> None:
    total = len(frs)
    top_status = max(status_ranks, key=status_ranks.get)
    if dimensions:
        # Multi-dim: one row per dimension with status counts.
        print(f"FR matrix: {total} entries  |  status dimensions: {', '.join(dimensions)}")
        # Column header
        col_names = sorted(status_ranks, key=status_ranks.get, reverse=True)
        header = "  {:<10}  ".format("dimension") + "  ".join(f"{n:>16}" for n in col_names)
        print(header)
        unknowns = set()
        for dim in dimensions:
            row_counts = []
            for name in col_names:
                n = sum(1 for f in frs.values() if isinstance(f["status"], dict) and f["status"].get(dim) == name)
                row_counts.append(f"{n:>16}")
            print("  {:<10}  ".format(dim) + "  ".join(row_counts))
            for f in frs.values():
                if isinstance(f["status"], dict):
                    v = f["status"].get(dim)
                    if v not in status_ranks:
                        unknowns.add((dim, v))
        if unknowns:
            print(f"  UNKNOWN status names (typos?): {sorted(unknowns)}")
    else:
        top_count = sum(1 for f in frs.values() if f["status"] == top_status)
        pct = (top_count * 100) // total if total else 0
        print(f"FR matrix: {total} entries  |  {top_status} {top_count}/{total} ({pct}%)")
        for name in sorted(status_ranks, key=status_ranks.get, reverse=True):
            if name == top_status:
                continue
            n = sum(1 for f in frs.values() if f["status"] == name)
            print(f"  {name:<16}: {n}")
        unknown = {f["status"] for f in frs.values() if f["status"] not in status_ranks}
        if unknown:
            print(f"  UNKNOWN status names (typos?): {sorted(unknown)}")
    for bucket in buckets:
        with_bucket = sum(1 for f in frs.values() if f["tests"][bucket])
        print(f"  >=1 {bucket:<6} test: {with_bucket}")


def check_regressions(
    frs: dict[str, dict],
    baseline: dict,
    status_ranks: dict[str, int],
    dimensions: list[str],
) -> list[str]:
    """Compare current matrix against baseline.

    For multi-dim mode the baseline stores a {dim: name} dict per FR; the
    gate fails if ANY dimension regressed. Backward compat: when baseline
    has a string value but matrix is multi-dim, the string is interpreted
    as the floor for every dimension.
    """
    errors: list[str] = []
    for fr_id, base_status in baseline.items():
        if fr_id not in frs:
            errors.append(f"FR {fr_id} missing from current matrix (baseline had {base_status})")
            continue
        cur_status = frs[fr_id]["status"]
        if dimensions:
            cur_dict = cur_status if isinstance(cur_status, dict) else {d: cur_status for d in dimensions}
            base_dict = base_status if isinstance(base_status, dict) else {d: base_status for d in dimensions}
            for dim in dimensions:
                cur_val = cur_dict.get(dim)
                base_val = base_dict.get(dim)
                if cur_val is None or base_val is None:
                    continue
                if cur_val not in status_ranks or base_val not in status_ranks:
                    continue
                if status_ranks[cur_val] < status_ranks[base_val]:
                    errors.append(
                        f"FR {fr_id}.{dim} regressed: baseline={base_val} current={cur_val}"
                    )
        else:
            if cur_status not in status_ranks:
                errors.append(f"FR {fr_id} has unknown status {cur_status!r}")
                continue
            if base_status not in status_ranks:
                continue
            if status_ranks[cur_status] < status_ranks[base_status]:
                errors.append(
                    f"FR {fr_id} regressed: baseline={base_status} current={cur_status}"
                )
    return errors


def write_baseline(frs: dict[str, dict]) -> None:
    payload = {
        "_comment": (
            "Per-FR status floor. CI fails if any FR drops below this rank. "
            "In multi-dim mode the per-FR value is a {dimension: status} dict "
            "and the gate compares each dimension independently. Refresh "
            "deliberately via `python scripts/check-traceability.py "
            "--write-baseline` after an intentional downgrade."
        ),
        "frs": {fr_id: f["status"] for fr_id, f in sorted(frs.items())},
    }
    BASELINE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"baseline written: {BASELINE.relative_to(ROOT)}")


# Global filled by main() — read_config result. The parse_matrix function
# needs this for its default-status fallback.
STATUS_RANKS_GLOBAL: dict[str, int] = {}


def main(argv: list[str]) -> int:
    global STATUS_RANKS_GLOBAL
    if not MATRIX.exists():
        print(f"missing matrix at {MATRIX}", file=sys.stderr)
        return 2
    text = MATRIX.read_text(encoding="utf-8")
    cfg = read_config(text)
    fr_re = re.compile(cfg["fr_pattern"])
    status_ranks = parse_status_ranks(cfg["status_ranks"])
    STATUS_RANKS_GLOBAL = status_ranks
    buckets = [b.strip() for b in cfg["test_buckets"].split(",") if b.strip()]
    dimensions = [d.strip() for d in cfg.get("status_dimensions", "").split(",") if d.strip()]

    frs = parse_matrix(text, fr_re, buckets, dimensions)
    print_summary(frs, status_ranks, buckets, dimensions)

    if "--write-baseline" in argv:
        write_baseline(frs)
        return 0
    if not BASELINE.exists():
        print(
            f"\n(no baseline yet — run `python {sys.argv[0]} --write-baseline` to create one)",
            file=sys.stderr,
        )
        return 0
    baseline_doc = json.loads(BASELINE.read_text(encoding="utf-8"))
    errors = check_regressions(frs, baseline_doc.get("frs", {}), status_ranks, dimensions)
    if errors:
        print("\nTRACEABILITY REGRESSIONS:")
        for e in errors:
            print(f"  - {e}")
        print(
            "\nIf the regression is intentional, refresh the baseline:\n"
            f"  python {sys.argv[0]} --write-baseline"
        )
        return 1
    print("\ntraceability gate: ok (no regressions vs baseline)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
