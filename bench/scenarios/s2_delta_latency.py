"""
S2: Delta Latency Benchmark

Measures change delivery latency -- time from DML commit to client
receiving the change notification.

For push-based approaches (pg_reactive, listen/notify): time from INSERT
to receiving the notification on a separate listener connection.

For pg_ivm: the IMMV is updated synchronously within the DML transaction,
so "delivery latency" is the DML commit duration itself.

For polling: wait_for_change internally polls at its configured interval,
so latency includes polling overhead.
"""

import sys
import time

# Per-query DML: maps query_id to (INSERT_SQL, CLEANUP_SQL) that will
# actually produce a delta for that query's tracked tables.
QUERY_DML = {
    "Q3": (
        "INSERT INTO orders (customer_id, product_id, qty, total) VALUES (1, 1, 1, 99.99)",
        "DELETE FROM orders WHERE qty = 1 AND total = 99.99",
    ),
    "Q2": (
        "INSERT INTO products (name, price, category) VALUES ('bench_probe', 42.00, 'electronics')",
        "DELETE FROM products WHERE name = 'bench_probe'",
    ),
}

# Preferred query per adapter: try Q3 (multi-table JOIN), fall back to Q2 (single-table)
PREFERRED_QUERIES = ["Q3", "Q2"]

ITERATIONS = 100
INTER_ITERATION_SLEEP_S = 0.01  # 10ms


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Compute a percentile from an already-sorted list (no numpy)."""
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (pct / 100.0)
    f = int(k)
    c = f + 1
    if c >= len(sorted_values):
        return sorted_values[f]
    d = k - f
    return sorted_values[f] + d * (sorted_values[c] - sorted_values[f])


def _compute_stats(latencies_us: list[float]) -> dict:
    """Compute summary statistics from a list of latency values in microseconds."""
    if not latencies_us:
        return {
            "p50_us": 0.0,
            "p95_us": 0.0,
            "p99_us": 0.0,
            "min_us": 0.0,
            "max_us": 0.0,
            "avg_us": 0.0,
        }
    s = sorted(latencies_us)
    return {
        "p50_us": round(_percentile(s, 50), 2),
        "p95_us": round(_percentile(s, 95), 2),
        "p99_us": round(_percentile(s, 99), 2),
        "min_us": round(s[0], 2),
        "max_us": round(s[-1], 2),
        "avg_us": round(sum(s) / len(s), 2),
    }


def _run_push_based(adapter, queries: dict, connect_fn, iterations: int,
                    query_id: str, insert_sql: str, cleanup_sql: str) -> dict:
    """Run latency measurement for push-based approaches (pg_reactive, listen/notify)."""
    query_sql = queries[query_id]

    writer_conn = connect_fn(autocommit=True)
    listener_conn = connect_fn(autocommit=True)

    try:
        adapter.setup(writer_conn, query_id, query_sql)
        adapter.setup_listener(listener_conn, query_id)

        # Drain any stale notifications
        listener_conn.poll()
        while listener_conn.notifies:
            listener_conn.notifies.pop(0)

        latencies_us: list[float] = []
        misses = 0

        for i in range(iterations):
            t0 = time.monotonic()

            with writer_conn.cursor() as cur:
                cur.execute(insert_sql)

            result = adapter.wait_for_change(listener_conn, query_id, timeout_s=5.0)

            t1 = time.monotonic()

            if result is not None and result.get("received"):
                latency_us = (t1 - t0) * 1_000_000
                latencies_us.append(latency_us)
            else:
                misses += 1

            if (i + 1) % 10 == 0 or (i + 1) == iterations:
                if latencies_us:
                    current_p50 = _percentile(sorted(latencies_us), 50)
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"p50={current_p50:.0f}us, misses={misses}",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"all misses so far ({misses})",
                        file=sys.stderr,
                    )

            time.sleep(INTER_ITERATION_SLEEP_S)

        adapter.teardown(writer_conn, query_id)

    finally:
        try:
            with writer_conn.cursor() as cur:
                cur.execute(cleanup_sql)
        except Exception:
            pass
        writer_conn.close()
        listener_conn.close()

    stats = _compute_stats(latencies_us)
    return {
        "approach": adapter.name,
        "query": query_id,
        "latencies_us": [round(v, 2) for v in latencies_us],
        **stats,
        "misses": misses,
        "produces_delta": adapter.produces_delta,
        "push_based": adapter.push_based,
    }


def _run_ivm(adapter, queries: dict, connect_fn, iterations: int,
             query_id: str, insert_sql: str, cleanup_sql: str) -> dict:
    """Run latency measurement for pg_ivm.

    pg_ivm updates the IMMV synchronously within the DML transaction,
    so "delivery latency" is the time the INSERT takes to commit.
    After INSERT, we call wait_for_change just to confirm the view updated.
    """
    query_id_local = query_id
    query_sql = queries[query_id_local]

    writer_conn = connect_fn(autocommit=False)
    listener_conn = connect_fn(autocommit=True)

    try:
        adapter.setup(writer_conn, query_id_local, query_sql)
        writer_conn.commit()

        latencies_us: list[float] = []
        misses = 0

        for i in range(iterations):
            t0 = time.monotonic()

            with writer_conn.cursor() as cur:
                cur.execute(insert_sql)
            writer_conn.commit()

            t1 = time.monotonic()

            # Confirm the IMMV reflects the change
            result = adapter.wait_for_change(listener_conn, query_id_local, timeout_s=5.0)

            if result is not None and result.get("received"):
                latency_us = (t1 - t0) * 1_000_000
                latencies_us.append(latency_us)
            else:
                misses += 1

            if (i + 1) % 10 == 0 or (i + 1) == iterations:
                if latencies_us:
                    current_p50 = _percentile(sorted(latencies_us), 50)
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"p50={current_p50:.0f}us, misses={misses}",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"all misses so far ({misses})",
                        file=sys.stderr,
                    )

            time.sleep(INTER_ITERATION_SLEEP_S)

        adapter.teardown(writer_conn, query_id_local)
        writer_conn.commit()

    finally:
        try:
            with writer_conn.cursor() as cur:
                cur.execute(cleanup_sql)
            writer_conn.commit()
        except Exception:
            pass
        writer_conn.close()
        listener_conn.close()

    stats = _compute_stats(latencies_us)
    return {
        "approach": adapter.name,
        "query": query_id_local,
        "latencies_us": [round(v, 2) for v in latencies_us],
        **stats,
        "misses": misses,
        "produces_delta": adapter.produces_delta,
        "push_based": adapter.push_based,
    }


def _run_polling(adapter, queries: dict, connect_fn, iterations: int,
                 query_id: str, insert_sql: str, cleanup_sql: str) -> dict:
    """Run latency measurement for polling approach."""
    query_sql = queries[query_id]

    writer_conn = connect_fn(autocommit=True)
    listener_conn = connect_fn(autocommit=True)

    try:
        adapter.setup(writer_conn, query_id, query_sql)

        latencies_us: list[float] = []
        misses = 0

        for i in range(iterations):
            t0 = time.monotonic()

            with writer_conn.cursor() as cur:
                cur.execute(insert_sql)

            result = adapter.wait_for_change(listener_conn, query_id, timeout_s=5.0)

            t1 = time.monotonic()

            if result is not None and result.get("received"):
                latency_us = (t1 - t0) * 1_000_000
                latencies_us.append(latency_us)
            else:
                misses += 1

            if (i + 1) % 10 == 0 or (i + 1) == iterations:
                if latencies_us:
                    current_p50 = _percentile(sorted(latencies_us), 50)
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"p50={current_p50:.0f}us, misses={misses}",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"  {adapter.name}: {i + 1}/{iterations} done, "
                        f"all misses so far ({misses})",
                        file=sys.stderr,
                    )

            time.sleep(INTER_ITERATION_SLEEP_S)

        adapter.teardown(writer_conn, query_id)

    finally:
        try:
            with writer_conn.cursor() as cur:
                cur.execute(cleanup_sql)
        except Exception:
            pass
        writer_conn.close()
        listener_conn.close()

    stats = _compute_stats(latencies_us)
    return {
        "approach": adapter.name,
        "query": query_id,
        "latencies_us": [round(v, 2) for v in latencies_us],
        **stats,
        "misses": misses,
        "produces_delta": adapter.produces_delta,
        "push_based": adapter.push_based,
    }


def run(
    adapters: list,
    queries: dict,
    connect_fn,
    params: dict,
    duration: int,
) -> dict:
    """Entry point called by the harness.

    Args:
        adapters: List of BenchApproach instances to benchmark.
        queries: Dict mapping query IDs to SQL strings.
        connect_fn: Callable that returns a psycopg2 connection.
                    Accepts optional autocommit keyword argument.
        params: Additional scenario parameters from CLI.
        duration: Duration hint in seconds (used to scale iteration count).

    Returns:
        Dict with scenario name, iteration count, query ID, and per-approach results.
    """
    iterations = int(params.get("iterations", ITERATIONS))

    print(f"S2 Delta Latency: {iterations} iterations", file=sys.stderr)
    print(file=sys.stderr)

    results = []

    for adapter in adapters:
        # Pick the best supported query for this adapter
        query_id = None
        for qid in PREFERRED_QUERIES:
            if adapter.supports_query(qid) and qid in QUERY_DML:
                query_id = qid
                break

        if query_id is None:
            print(f"  {adapter.name}: skipping (no supported query with DML)", file=sys.stderr)
            results.append({
                "approach": adapter.name,
                "skipped": True,
                "reason": "no supported query with DML",
            })
            continue

        insert_sql, cleanup_sql = QUERY_DML[query_id]
        print(f"  Running {adapter.name} on {query_id}...", file=sys.stderr)

        try:
            if adapter.push_based:
                result = _run_push_based(adapter, queries, connect_fn, iterations,
                                         query_id, insert_sql, cleanup_sql)
            elif adapter.name == "pg_ivm":
                result = _run_ivm(adapter, queries, connect_fn, iterations,
                                  query_id, insert_sql, cleanup_sql)
            else:
                result = _run_polling(adapter, queries, connect_fn, iterations,
                                      query_id, insert_sql, cleanup_sql)

            results.append(result)
            print(
                f"  {adapter.name}: p50={result['p50_us']:.0f}us "
                f"p95={result['p95_us']:.0f}us "
                f"p99={result['p99_us']:.0f}us "
                f"misses={result['misses']}",
                file=sys.stderr,
            )

        except Exception as exc:
            print(
                f"  {adapter.name}: FAILED - {exc}", file=sys.stderr
            )
            results.append({
                "approach": adapter.name,
                "skipped": True,
                "reason": f"error: {exc}",
            })

        print(file=sys.stderr)

    return {
        "scenario": "s2_delta_latency",
        "iterations": iterations,
        "results": results,
    }
