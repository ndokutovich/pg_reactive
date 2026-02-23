"""
Scenario S3: Query Complexity / SQL Construct Compatibility.

For each adapter and each query Q1-Q8, attempt to register via setup()
and record whether it passes, fails, or is declared unsupported.

This scenario ignores `params` and `duration` -- it is a pure compatibility
matrix test.
"""

from __future__ import annotations

import sys
import traceback
from typing import Any, Callable, Dict, List

QUERY_IDS: List[str] = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]

# Unicode status glyphs
_PASS = "\u2713"     # check mark
_FAIL = "\u2717"     # ballot X
_SKIP = "~"          # not supported (expected)


def _test_one(adapter: Any, qid: str, sql: str, connect_fn: Callable) -> Dict[str, Any]:
    """Test a single adapter + query combination.

    Returns a dict with ``status`` ("pass", "fail", or "not_supported")
    and optionally ``error`` when status is "fail".
    """
    if not adapter.supports_query(qid):
        return {"status": "not_supported"}

    conn = None
    try:
        conn = connect_fn(autocommit=True)
        conn.autocommit = False

        adapter.setup(conn, qid, sql)
        conn.commit()

        # Optional: verify a basic read works after setup
        try:
            adapter.read_current(conn, qid, sql)
        except Exception:
            pass  # not all adapters implement read_current

        adapter.teardown(conn, qid)
        conn.commit()
        conn.close()
        conn = None
        return {"status": "pass"}

    except Exception as exc:
        error_msg = str(exc).strip().split("\n")[0]
        result: Dict[str, Any] = {"status": "fail", "error": error_msg}

        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
            try:
                # Attempt teardown to avoid leftover state
                adapter.teardown(conn, qid)
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
            try:
                conn.close()
            except Exception:
                pass

        return result


def _glyph(status: str) -> str:
    """Map a result status to its display glyph."""
    if status == "pass":
        return _PASS
    elif status == "not_supported":
        return _SKIP
    else:
        return _FAIL


def _print_table(
    adapters: List[Any],
    results_by_approach: Dict[str, Dict[str, Dict[str, Any]]],
) -> None:
    """Print a human-readable compatibility matrix to stdout."""
    # Column widths
    name_width = max(len(a.name) for a in adapters)
    name_width = max(name_width, len("Approach"))
    col_width = 4  # "  Q1" etc

    # Header
    header = f"{'Approach':<{name_width}}"
    for qid in QUERY_IDS:
        header += f"  {qid:>{col_width}}"
    print(header)
    print("-" * len(header))

    # Rows
    for adapter in adapters:
        matrix = results_by_approach.get(adapter.name, {})
        row = f"{adapter.name:<{name_width}}"
        for qid in QUERY_IDS:
            cell = matrix.get(qid, {})
            g = _glyph(cell.get("status", "fail"))
            row += f"  {g:>{col_width}}"
        print(row)

    print()


def run(
    adapters: List[Any],
    queries: Dict[str, str],
    connect_fn: Callable,
    params: Dict[str, str],
    duration: int,
) -> Dict[str, Any]:
    """Execute the S3 compatibility matrix.

    Args:
        adapters: List of BenchApproach instances.
        queries: Dict mapping query IDs (Q1-Q8) to SQL strings.
        connect_fn: Callable that returns a psycopg2 connection.
            Accepts an optional ``autocommit`` keyword argument.
        params: Ignored for this scenario.
        duration: Ignored for this scenario.

    Returns:
        A dict with scenario name, query list, and per-approach results.
    """
    # Ensure all expected queries are present
    active_queries = {qid: queries[qid] for qid in QUERY_IDS if qid in queries}
    if len(active_queries) < len(QUERY_IDS):
        missing = set(QUERY_IDS) - set(active_queries)
        print(
            f"Warning: missing queries {sorted(missing)}, skipping them.",
            file=sys.stderr,
        )

    results: List[Dict[str, Any]] = []
    results_by_approach: Dict[str, Dict[str, Dict[str, Any]]] = {}

    for adapter in adapters:
        print(f"Testing {adapter.name} ...", flush=True)
        matrix: Dict[str, Dict[str, Any]] = {}

        for qid in QUERY_IDS:
            sql = active_queries.get(qid)
            if sql is None:
                matrix[qid] = {"status": "not_supported"}
                continue

            outcome = _test_one(adapter, qid, sql, connect_fn)
            matrix[qid] = outcome

            status_char = _glyph(outcome["status"])
            detail = ""
            if outcome.get("error"):
                detail = f'  ({outcome["error"][:60]})'
            print(f"  {qid}: {status_char}{detail}", flush=True)

        results_by_approach[adapter.name] = matrix
        results.append(
            {
                "approach": adapter.name,
                "produces_delta": adapter.produces_delta,
                "push_based": adapter.push_based,
                "matrix": matrix,
            }
        )

    # Summary table
    print()
    _print_table(adapters, results_by_approach)

    return {
        "scenario": "s3_query_complexity",
        "queries": list(active_queries.keys()),
        "results": results,
    }
