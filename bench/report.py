#!/usr/bin/env python3
"""
Benchmark report generator for pg_reactive.

Reads raw JSON benchmark results from a directory and produces a comprehensive
markdown comparison report.

Usage:
    python3 report.py --input /bench/results/raw --output /bench/results/report.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APPROACH_ORDER: list[str] = [
    "pg_reactive",
    "pg_ivm",
    "polling",
    "listen_notify",
    "hasura",
    "debezium",
    "supabase",
    "electric",
]

APPROACH_DISPLAY_NAMES: dict[str, str] = {
    "pg_reactive": "pg_reactive",
    "pg_ivm": "pg_ivm",
    "polling": "Polling",
    "listen_notify": "LISTEN/NOTIFY",
    "hasura": "Hasura",
    "debezium": "Debezium",
    "supabase": "Supabase",
    "electric": "ElectricSQL",
}

QUERY_CONSTRUCTS: dict[str, str] = {
    "Q1": "JOIN x2 + WHERE",
    "Q2": "Single-table WHERE",
    "Q3": "JOIN x2",
    "Q4": "LEFT JOIN + GROUP BY",
    "Q5": "GROUP BY + HAVING",
    "Q6": "Window function",
    "Q7": "CTE + JOIN",
    "Q8": "ORDER BY + LIMIT",
}

EXPECTED_FILES: dict[str, str] = {
    "s1_write_overhead": "s1_write_overhead.json",
    "s2_delta_latency": "s2_delta_latency.json",
    "s3_query_complexity": "s3_query_complexity.json",
    "s4_scale_100": "s4_scale_100.json",
    "s4_scale_1000": "s4_scale_1000.json",
    "s4_scale_10000": "s4_scale_10000.json",
    "s5_subscription_scale": "s5_subscription_scale.json",
    "s6_fanout": "s6_fanout.json",
    "s2_tier2": "s2_tier2.json",
    "s3_tier2": "s3_tier2.json",
}


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _fmt_int(value: Any) -> str:
    """Format a numeric value as a comma-separated integer string.

    Args:
        value: Numeric value or None.

    Returns:
        Formatted string with commas, or a dash for missing values.
    """
    if value is None:
        return "\u2014"
    try:
        return f"{int(round(float(value))):,}"
    except (TypeError, ValueError):
        return "\u2014"


def _fmt_float(value: Any, decimals: int = 1) -> str:
    """Format a numeric value as a float string with specified decimal places.

    Args:
        value: Numeric value or None.
        decimals: Number of decimal places.

    Returns:
        Formatted string or a dash for missing values.
    """
    if value is None:
        return "\u2014"
    try:
        return f"{float(value):,.{decimals}f}"
    except (TypeError, ValueError):
        return "\u2014"


def _fmt_pct(value: Any) -> str:
    """Format a percentage value with sign and 1 decimal place.

    Args:
        value: Percentage value (e.g. 2.3 means +2.3%).

    Returns:
        Formatted string like '+2.3%' or a dash for missing values.
    """
    if value is None:
        return "\u2014"
    try:
        v = float(value)
        sign = "+" if v >= 0 else ""
        return f"{sign}{v:.1f}%"
    except (TypeError, ValueError):
        return "\u2014"


def _fmt_bool(value: Any) -> str:
    """Format a boolean as a check mark or cross.

    Args:
        value: Boolean or truthy/falsy value, or None.

    Returns:
        Unicode check mark, cross, or dash.
    """
    if value is None:
        return "\u2014"
    return "\u2705" if value else "\u274c"


def _display_name(approach: str) -> str:
    """Return the human-friendly display name for an approach.

    Args:
        approach: Internal approach identifier.

    Returns:
        Display name string.
    """
    return APPROACH_DISPLAY_NAMES.get(approach, approach)


def _sort_key(approach: str) -> int:
    """Return a sort key for consistent approach ordering.

    Args:
        approach: Internal approach identifier.

    Returns:
        Integer sort position.
    """
    try:
        return APPROACH_ORDER.index(approach)
    except ValueError:
        return len(APPROACH_ORDER)


def _sort_approaches(approaches: list[str]) -> list[str]:
    """Sort approach names in the canonical order.

    Args:
        approaches: List of approach identifiers.

    Returns:
        Sorted list.
    """
    return sorted(approaches, key=_sort_key)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_json(path: str) -> Optional[dict]:
    """Load a JSON file, returning None if it does not exist or is invalid.

    Args:
        path: Absolute path to the JSON file.

    Returns:
        Parsed dict or None.
    """
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  WARNING: Could not read {path}: {exc}", file=sys.stderr)
        return None


def _load_all(input_dir: str) -> dict[str, Optional[dict]]:
    """Load all expected JSON result files from the input directory.

    Args:
        input_dir: Directory containing raw JSON result files.

    Returns:
        Dict mapping scenario key to parsed data (or None if missing).
    """
    data: dict[str, Optional[dict]] = {}
    for key, filename in EXPECTED_FILES.items():
        path = os.path.join(input_dir, filename)
        data[key] = _load_json(path)
    return data


def _get_results_by_approach(data: dict) -> dict[str, dict]:
    """Index a scenario's results list by approach name.

    Args:
        data: Scenario data dict containing a 'results' list.

    Returns:
        Dict mapping approach name to its result dict.
    """
    results: dict[str, dict] = {}
    for entry in data.get("results", []):
        name = entry.get("approach", "")
        results[name] = entry
    return results


# ---------------------------------------------------------------------------
# Section generators
# ---------------------------------------------------------------------------

def _section_feature_matrix(
    s3_data: Optional[dict],
    s3_tier2: Optional[dict],
) -> str:
    """Generate the Feature Matrix (S3) section.

    Args:
        s3_data: Tier 1 S3 results.
        s3_tier2: Tier 2 S3 results (optional).

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 1. Feature Matrix (S3)")
    lines.append("")
    lines.append("Shows which SQL constructs each approach supports.")
    lines.append("")

    if s3_data is None and s3_tier2 is None:
        lines.append("*S3 data not available.*")
        lines.append("")
        return "\n".join(lines)

    # Merge results from both tiers
    by_approach: dict[str, dict] = {}
    for src in (s3_data, s3_tier2):
        if src is not None:
            by_approach.update(_get_results_by_approach(src))

    approaches = _sort_approaches(list(by_approach.keys()))
    query_ids = list(QUERY_CONSTRUCTS.keys())

    # Header
    header_parts = ["| Query | Construct"]
    separator_parts = ["|-------|----------"]
    for a in approaches:
        header_parts.append(f" {_display_name(a)} ")
        separator_parts.append(":---:")
    header = "|".join(header_parts) + "|"
    separator = "|".join(separator_parts) + "|"
    lines.append(header)
    lines.append(separator)

    # Rows
    for qid in query_ids:
        construct = QUERY_CONSTRUCTS.get(qid, "")
        row_parts = [f"| {qid}    | {construct}"]
        for a in approaches:
            entry = by_approach.get(a, {})
            matrix = entry.get("matrix", {})
            cell = matrix.get(qid, {})
            status = cell.get("status", "not_supported")
            if status == "pass":
                glyph = "\u2705"
            elif status == "fail":
                glyph = "\u274c"
            else:
                glyph = "\u2014"
            row_parts.append(f" {glyph} ")
        lines.append("|".join(row_parts) + "|")

    # Totals row
    total_parts = ["| **Total** | "]
    for a in approaches:
        entry = by_approach.get(a, {})
        matrix = entry.get("matrix", {})
        count = sum(
            1 for qid in query_ids
            if matrix.get(qid, {}).get("status") == "pass"
        )
        total_parts.append(f" **{count}/{len(query_ids)}** ")
    lines.append("|".join(total_parts) + "|")

    lines.append("")
    lines.append("**Key:** \u2705 = supported, \u274c = failed, \u2014 = not applicable")
    lines.append("")
    return "\n".join(lines)


def _section_write_overhead(s1_data: Optional[dict]) -> str:
    """Generate the Write Overhead (S1) section.

    Args:
        s1_data: S1 benchmark results.

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 2. Write Overhead (S1)")
    lines.append("")
    lines.append("How much does each approach slow down writes?")
    lines.append("")

    if s1_data is None:
        lines.append("*S1 data not available.*")
        lines.append("")
        return "\n".join(lines)

    baseline = s1_data.get("baseline", {})
    duration = s1_data.get("duration_s", "?")

    # Baseline table
    lines.append(f"### Baseline ({duration}s measurement)")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|--------|------:|")
    lines.append(f"| TPS | {_fmt_float(baseline.get('tps'), 0)} |")
    lines.append(f"| p50 | {_fmt_int(baseline.get('p50_us'))}\u00b5s |")
    lines.append(f"| p95 | {_fmt_int(baseline.get('p95_us'))}\u00b5s |")
    lines.append(f"| p99 | {_fmt_int(baseline.get('p99_us'))}\u00b5s |")
    lines.append(f"| Total ops | {_fmt_int(baseline.get('total_ops'))} |")
    lines.append("")

    # Per-approach overhead table
    by_approach = _get_results_by_approach(s1_data)
    approaches = _sort_approaches(list(by_approach.keys()))

    # Discover subscription levels present in results
    all_levels: set[str] = set()
    for a in approaches:
        entry = by_approach[a]
        all_levels.update(entry.get("levels", {}).keys())
    sorted_levels = sorted(all_levels, key=lambda x: int(x))

    if not sorted_levels:
        lines.append("*No subscription-level data available.*")
        lines.append("")
        return "\n".join(lines)

    lines.append("### Overhead by Subscription Count")
    lines.append("")

    # Build header
    header_parts = ["| Approach"]
    separator_parts = ["|----------"]
    for level in sorted_levels:
        header_parts.append(f" {level} Sub TPS ")
        header_parts.append(f" {level} Sub Overhead ")
        separator_parts.append(":---:")
        separator_parts.append(":---:")
    header = "|".join(header_parts) + "|"
    separator = "|".join(separator_parts) + "|"
    lines.append(header)
    lines.append(separator)

    for a in approaches:
        entry = by_approach[a]
        levels_data = entry.get("levels", {})
        row_parts = [f"| {_display_name(a)}"]
        for level in sorted_levels:
            level_stats = levels_data.get(level, {})
            tps = level_stats.get("tps")
            overhead = level_stats.get("overhead_pct")
            row_parts.append(f" {_fmt_float(tps, 0)} ")
            row_parts.append(f" {_fmt_pct(overhead)} ")
        lines.append("|".join(row_parts) + "|")

    lines.append("")
    return "\n".join(lines)


def _section_delta_latency(
    s2_data: Optional[dict],
    s2_tier2: Optional[dict],
) -> str:
    """Generate the Change Delivery Latency (S2) section.

    Args:
        s2_data: Tier 1 S2 results.
        s2_tier2: Tier 2 S2 results (optional).

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 3. Change Delivery Latency (S2)")
    lines.append("")
    lines.append("Time from DML commit to client receiving the change.")
    lines.append("")

    if s2_data is None and s2_tier2 is None:
        lines.append("*S2 data not available.*")
        lines.append("")
        return "\n".join(lines)

    # Merge results
    by_approach: dict[str, dict] = {}
    for src in (s2_data, s2_tier2):
        if src is not None:
            by_approach.update(_get_results_by_approach(src))

    approaches = _sort_approaches(list(by_approach.keys()))

    iterations = None
    for src in (s2_data, s2_tier2):
        if src is not None and "iterations" in src:
            iterations = src["iterations"]
            break

    if iterations is not None:
        lines.append(f"*{iterations} iterations per approach.*")
        lines.append("")

    lines.append(
        "| Approach | p50 (\u00b5s) | p95 (\u00b5s) | p99 (\u00b5s) "
        "| Min (\u00b5s) | Max (\u00b5s) | Misses | Delta? | Push? |"
    )
    lines.append(
        "|----------|:--------:|:--------:|:--------:"
        "|:---:|:---:|:------:|:------:|:-----:|"
    )

    for a in approaches:
        entry = by_approach[a]
        if entry.get("skipped"):
            reason = entry.get("reason", "skipped")
            lines.append(
                f"| {_display_name(a)} | "
                f"\u2014 | \u2014 | \u2014 | \u2014 | \u2014 | \u2014 | "
                f"\u2014 | \u2014 | *{reason}*"
            )
            continue

        p50 = _fmt_int(entry.get("p50_us"))
        p95 = _fmt_int(entry.get("p95_us"))
        p99 = _fmt_int(entry.get("p99_us"))
        min_v = _fmt_int(entry.get("min_us"))
        max_v = _fmt_int(entry.get("max_us"))
        misses = entry.get("misses", "\u2014")
        delta = _fmt_bool(entry.get("produces_delta"))
        push = _fmt_bool(entry.get("push_based"))

        lines.append(
            f"| {_display_name(a)} | {p50} | {p95} | {p99} "
            f"| {min_v} | {max_v} | {misses} | {delta} | {push} |"
        )

    lines.append("")
    return "\n".join(lines)


def _section_result_set_scale(
    s4_100: Optional[dict],
    s4_1000: Optional[dict],
    s4_10000: Optional[dict],
) -> str:
    """Generate the Result Set Scaling (S4) section.

    Args:
        s4_100: S4 results at scale=100.
        s4_1000: S4 results at scale=1000.
        s4_10000: S4 results at scale=10000.

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 4. Result Set Scaling (S4)")
    lines.append("")
    lines.append("How does performance degrade with larger result sets?")
    lines.append("")

    scale_data: list[tuple[int, Optional[dict]]] = [
        (100, s4_100),
        (1000, s4_1000),
        (10000, s4_10000),
    ]

    available = [(s, d) for s, d in scale_data if d is not None]
    if not available:
        lines.append("*S4 data not available.*")
        lines.append("")
        return "\n".join(lines)

    # Collect all approaches across scales
    all_approaches: set[str] = set()
    for _, d in available:
        for entry in d.get("results", []):
            all_approaches.add(entry.get("approach", ""))
    approaches = _sort_approaches(list(all_approaches))

    # TPS table
    lines.append("### Write TPS by Scale")
    lines.append("")
    header_parts = ["| Scale | Rows"]
    sep_parts = ["|-------|-----"]
    for a in approaches:
        header_parts.append(f" {_display_name(a)} TPS ")
        sep_parts.append(":---:")
    lines.append("|".join(header_parts) + "|")
    lines.append("|".join(sep_parts) + "|")

    for scale, d in scale_data:
        if d is None:
            continue
        by_approach = _get_results_by_approach(d)
        # Estimate row count from first approach's snapshot
        sample_rows = "\u2014"
        for entry in d.get("results", []):
            sr = entry.get("snapshot_rows")
            if sr is not None and sr >= 0:
                sample_rows = f"~{_fmt_int(sr)}"
                break

        row_parts = [f"| {_fmt_int(scale)} | {sample_rows}"]
        for a in approaches:
            entry = by_approach.get(a, {})
            tps = entry.get("write_tps")
            row_parts.append(f" {_fmt_float(tps, 0)} ")
        lines.append("|".join(row_parts) + "|")

    lines.append("")

    # Delivery latency table
    lines.append("### Delivery Latency by Scale")
    lines.append("")
    header_parts = ["| Scale"]
    sep_parts = ["|------"]
    for a in approaches:
        header_parts.append(f" {_display_name(a)} p50 (\u00b5s) ")
        sep_parts.append(":---:")
    lines.append("|".join(header_parts) + "|")
    lines.append("|".join(sep_parts) + "|")

    for scale, d in scale_data:
        if d is None:
            continue
        by_approach = _get_results_by_approach(d)
        row_parts = [f"| {_fmt_int(scale)}"]
        for a in approaches:
            entry = by_approach.get(a, {})
            latency = entry.get("delivery_latency", {})
            p50 = latency.get("p50_us")
            row_parts.append(f" {_fmt_int(p50)} ")
        lines.append("|".join(row_parts) + "|")

    lines.append("")
    return "\n".join(lines)


def _section_subscription_scale(s5_data: Optional[dict]) -> str:
    """Generate the Subscription Count Scaling (S5) section.

    Args:
        s5_data: S5 benchmark results.

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 5. Subscription Count Scaling (S5)")
    lines.append("")
    lines.append("Write throughput with increasing active subscriptions.")
    lines.append("")

    if s5_data is None:
        lines.append("*S5 data not available.*")
        lines.append("")
        return "\n".join(lines)

    by_approach = _get_results_by_approach(s5_data)
    approaches = _sort_approaches(list(by_approach.keys()))

    # Collect all subscription levels
    all_levels: set[int] = set()
    for a in approaches:
        entry = by_approach[a]
        for m in entry.get("measurements", []):
            all_levels.add(m.get("subs", m.get("subs_requested", 0)))
    sorted_levels = sorted(all_levels)

    if not sorted_levels:
        lines.append("*No subscription level data available.*")
        lines.append("")
        return "\n".join(lines)

    # TPS table
    header_parts = ["| Subs"]
    sep_parts = ["|------"]
    for a in approaches:
        header_parts.append(f" {_display_name(a)} TPS ")
        sep_parts.append(":---:")
    lines.append("|".join(header_parts) + "|")
    lines.append("|".join(sep_parts) + "|")

    for level in sorted_levels:
        row_parts = [f"| {level}"]
        for a in approaches:
            entry = by_approach[a]
            measurements = entry.get("measurements", [])
            tps = None
            for m in measurements:
                m_subs = m.get("subs", m.get("subs_requested", -1))
                if m_subs == level:
                    tps = m.get("tps")
                    break
            row_parts.append(f" {_fmt_float(tps, 0)} ")
        lines.append("|".join(row_parts) + "|")

    lines.append("")
    return "\n".join(lines)


def _section_fanout(s6_data: Optional[dict]) -> str:
    """Generate the Fan-out (S6) section.

    Args:
        s6_data: S6 benchmark results (from Node.js).

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 6. Fan-out (S6)")
    lines.append("")
    lines.append("Delivery latency to N simultaneous WebSocket clients.")
    lines.append("")

    if s6_data is None:
        lines.append("*S6 data not available (requires Node.js proxy test).*")
        lines.append("")
        return "\n".join(lines)

    results = s6_data.get("results", [])
    if not results:
        lines.append("*S6 results are empty.*")
        lines.append("")
        return "\n".join(lines)

    lines.append(
        "| Clients | p50 All (ms) | p95 All (ms) "
        "| p50 First (ms) | Misses |"
    )
    lines.append(
        "|---------|:------------:|:------------:"
        "|:---------------:|:------:|"
    )

    for entry in sorted(results, key=lambda e: e.get("clients", 0)):
        clients = entry.get("clients", "\u2014")
        p50_all = _fmt_float(entry.get("p50_all_ms"), 1)
        p95_all = _fmt_float(entry.get("p95_all_ms"), 1)
        p50_first = _fmt_float(entry.get("p50_first_ms"), 1)
        misses = entry.get("misses", entry.get("total_misses", "\u2014"))
        lines.append(
            f"| {clients} | {p50_all} | {p95_all} "
            f"| {p50_first} | {misses} |"
        )

    lines.append("")
    return "\n".join(lines)


def _section_summary(
    s1_data: Optional[dict],
    s2_data: Optional[dict],
    s2_tier2: Optional[dict],
    s3_data: Optional[dict],
    s3_tier2: Optional[dict],
) -> str:
    """Generate the Summary section.

    Combines data from S1 (overhead), S2 (latency), and S3 (feature matrix)
    into a single comparison table.

    Args:
        s1_data: S1 write overhead results.
        s2_data: Tier 1 S2 delta latency results.
        s2_tier2: Tier 2 S2 delta latency results.
        s3_data: Tier 1 S3 query complexity results.
        s3_tier2: Tier 2 S3 query complexity results.

    Returns:
        Markdown string for this section.
    """
    lines: list[str] = []
    lines.append("## 7. Summary")
    lines.append("")

    # Merge S3 data for feature counts
    s3_by_approach: dict[str, dict] = {}
    for src in (s3_data, s3_tier2):
        if src is not None:
            s3_by_approach.update(_get_results_by_approach(src))

    # Merge S2 data for latency
    s2_by_approach: dict[str, dict] = {}
    for src in (s2_data, s2_tier2):
        if src is not None:
            s2_by_approach.update(_get_results_by_approach(src))

    # S1 data for write overhead
    s1_by_approach: dict[str, dict] = {}
    if s1_data is not None:
        s1_by_approach = _get_results_by_approach(s1_data)

    # Collect all known approaches
    all_approaches: set[str] = set()
    all_approaches.update(s3_by_approach.keys())
    all_approaches.update(s2_by_approach.keys())
    all_approaches.update(s1_by_approach.keys())
    approaches = _sort_approaches(list(all_approaches))

    if not approaches:
        lines.append("*No data available for summary.*")
        lines.append("")
        return "\n".join(lines)

    total_queries = len(QUERY_CONSTRUCTS)

    lines.append(
        "| Approach | SQL Support | Write Overhead (10 subs) "
        "| Delivery p50 | Delta Stream | Push-based |"
    )
    lines.append(
        "|----------|:-----------:|:------------------------:"
        "|:------------:|:------------:|:----------:|"
    )

    for a in approaches:
        name = _display_name(a)

        # SQL support count
        s3_entry = s3_by_approach.get(a, {})
        matrix = s3_entry.get("matrix", {})
        if matrix:
            pass_count = sum(
                1 for qid in QUERY_CONSTRUCTS
                if matrix.get(qid, {}).get("status") == "pass"
            )
            sql_support = f"{pass_count}/{total_queries}"
        else:
            sql_support = "\u2014"

        # Write overhead at 10 subs
        s1_entry = s1_by_approach.get(a, {})
        levels = s1_entry.get("levels", {})
        ten_sub = levels.get("10", levels.get(10, {}))
        overhead = ten_sub.get("overhead_pct") if ten_sub else None
        overhead_str = _fmt_pct(overhead) if overhead is not None else "\u2014"

        # Delivery p50
        s2_entry = s2_by_approach.get(a, {})
        if s2_entry.get("skipped"):
            p50_str = "\u2014"
        else:
            p50_val = s2_entry.get("p50_us")
            if p50_val is not None:
                p50_str = f"{_fmt_int(p50_val)}\u00b5s"
            else:
                p50_str = "\u2014"

        # Delta and push from any available source
        delta = None
        push = None
        for src_dict in (s2_by_approach, s3_by_approach):
            entry = src_dict.get(a, {})
            if "produces_delta" in entry:
                delta = entry["produces_delta"]
            if "push_based" in entry:
                push = entry["push_based"]

        delta_str = _fmt_bool(delta)
        push_str = _fmt_bool(push)

        lines.append(
            f"| {name} | {sql_support} | {overhead_str} "
            f"| {p50_str} | {delta_str} | {push_str} |"
        )

    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

def generate_report(input_dir: str) -> str:
    """Generate the full markdown benchmark report.

    Args:
        input_dir: Directory containing raw JSON result files.

    Returns:
        Complete markdown report as a string.
    """
    data = _load_all(input_dir)

    # Determine duration from whichever scenario is available
    duration = "\u2014"
    for key in ("s1_write_overhead", "s2_delta_latency"):
        d = data.get(key)
        if d is not None and "duration_s" in d:
            duration = str(d["duration_s"])
            break

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    sections: list[str] = []

    # Header
    sections.append("# pg_reactive Benchmark Report")
    sections.append("")
    sections.append(f"**Generated:** {timestamp}")
    sections.append("**PostgreSQL:** 16")
    sections.append(f"**Duration:** {duration}s per scenario")
    sections.append("")

    # Sections
    sections.append(_section_feature_matrix(
        data.get("s3_query_complexity"),
        data.get("s3_tier2"),
    ))

    sections.append(_section_write_overhead(
        data.get("s1_write_overhead"),
    ))

    sections.append(_section_delta_latency(
        data.get("s2_delta_latency"),
        data.get("s2_tier2"),
    ))

    sections.append(_section_result_set_scale(
        data.get("s4_scale_100"),
        data.get("s4_scale_1000"),
        data.get("s4_scale_10000"),
    ))

    sections.append(_section_subscription_scale(
        data.get("s5_subscription_scale"),
    ))

    sections.append(_section_fanout(
        data.get("s6_fanout"),
    ))

    sections.append(_section_summary(
        data.get("s1_write_overhead"),
        data.get("s2_delta_latency"),
        data.get("s2_tier2"),
        data.get("s3_query_complexity"),
        data.get("s3_tier2"),
    ))

    # Footer
    sections.append("---")
    sections.append("*Generated by bench/report.py*")
    sections.append("")

    return "\n".join(sections)


def _print_summary(input_dir: str, data: dict[str, Optional[dict]]) -> None:
    """Print a brief summary of loaded data to stdout.

    Args:
        input_dir: Path to the input directory.
        data: Dict of loaded scenario data.
    """
    loaded = [k for k, v in data.items() if v is not None]
    missing = [k for k, v in data.items() if v is None]

    print(f"Input directory: {input_dir}")
    print(f"Loaded:  {len(loaded)} / {len(data)} scenario files")

    if loaded:
        print(f"  Present: {', '.join(sorted(loaded))}")
    if missing:
        print(f"  Missing: {', '.join(sorted(missing))}")

    # Quick stats from S1
    s1 = data.get("s1_write_overhead")
    if s1 is not None:
        baseline_tps = s1.get("baseline", {}).get("tps")
        if baseline_tps is not None:
            print(f"  S1 baseline TPS: {_fmt_float(baseline_tps, 0)}")

    # Quick stats from S2
    s2 = data.get("s2_delta_latency")
    if s2 is not None:
        for entry in s2.get("results", []):
            if entry.get("approach") == "pg_reactive" and not entry.get("skipped"):
                p50 = entry.get("p50_us")
                if p50 is not None:
                    print(f"  S2 pg_reactive p50: {_fmt_int(p50)}us")
                break

    # Quick stats from S3
    s3 = data.get("s3_query_complexity")
    if s3 is not None:
        for entry in s3.get("results", []):
            if entry.get("approach") == "pg_reactive":
                matrix = entry.get("matrix", {})
                passed = sum(
                    1 for v in matrix.values()
                    if v.get("status") == "pass"
                )
                print(f"  S3 pg_reactive: {passed}/{len(QUERY_CONSTRUCTS)} queries supported")
                break


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Parse arguments and generate the benchmark report."""
    parser = argparse.ArgumentParser(
        description="Generate pg_reactive benchmark report from raw JSON results."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Directory containing raw JSON result files.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output path for the generated markdown report.",
    )
    args = parser.parse_args()

    input_dir = os.path.abspath(args.input)
    output_path = os.path.abspath(args.output)

    if not os.path.isdir(input_dir):
        print(f"ERROR: Input directory does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)

    # Load and summarize
    data = _load_all(input_dir)
    _print_summary(input_dir, data)
    print()

    # Generate report
    report = generate_report(input_dir)

    # Write output
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"Report written to: {output_path}")
    print(f"Report size: {len(report):,} bytes, {report.count(chr(10)):,} lines")


if __name__ == "__main__":
    main()
