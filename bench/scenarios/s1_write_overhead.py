"""
S1: Write Overhead — measures INSERT latency overhead per reactive approach.

Workflow:
  1. Baseline TPS with zero subscriptions active.
  2. For each adapter at subscription levels [1, 10]:
     a. Setup N subscriptions
     b. Run INSERT workload for `duration` seconds
     c. Record TPS and latency percentiles (p50, p95, p99)
     d. Teardown subscriptions
  3. Return JSON-serializable results dict.
"""

import sys
import time

INSERT_SQL = (
    "INSERT INTO orders (customer_id, product_id, qty, total) "
    "VALUES (%s, %s, %s, %s)"
)

SUBSCRIPTION_LEVELS = [1, 10]


def _percentile(sorted_values, pct):
    """Return the value at the given percentile from a pre-sorted list.

    Uses nearest-rank method. Returns 0.0 if the list is empty.
    """
    if not sorted_values:
        return 0.0
    k = int(len(sorted_values) * pct / 100.0)
    k = min(k, len(sorted_values) - 1)
    return sorted_values[k]


def _compute_stats(latencies_us, elapsed_s):
    """Compute TPS and latency percentiles from raw latency list.

    Args:
        latencies_us: List of per-operation latencies in microseconds.
        elapsed_s: Wall-clock duration of the workload in seconds.

    Returns:
        Dict with tps, p50_us, p95_us, p99_us, total_ops.
    """
    total_ops = len(latencies_us)
    tps = total_ops / elapsed_s if elapsed_s > 0 else 0.0
    sorted_lat = sorted(latencies_us)
    return {
        "tps": round(tps, 2),
        "p50_us": round(_percentile(sorted_lat, 50), 2),
        "p95_us": round(_percentile(sorted_lat, 95), 2),
        "p99_us": round(_percentile(sorted_lat, 99), 2),
        "total_ops": total_ops,
    }


def _get_table_counts(conn):
    """Query the number of customers and products in the database.

    Returns:
        Tuple of (n_customers, n_products).
    """
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM customers")
        n_customers = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM products")
        n_products = cur.fetchone()[0]
    return n_customers, n_products


def _run_insert_workload(connect_fn, duration_s, n_customers, n_products):
    """Run single-row INSERT workload for the given duration.

    Each INSERT is committed individually (autocommit). Latency of every
    operation is recorded using time.monotonic() for high-resolution timing.

    Args:
        connect_fn: Callable that returns a psycopg2 connection.
        duration_s: How many seconds to run the workload.
        n_customers: Number of customer IDs to cycle through.
        n_products: Number of product IDs to cycle through.

    Returns:
        Tuple of (latencies_us, elapsed_s) where latencies_us is a list of
        per-INSERT durations in microseconds.
    """
    conn = connect_fn(autocommit=True)
    latencies = []
    seq = 0
    deadline = time.monotonic() + duration_s

    try:
        cur = conn.cursor()
        while True:
            cid = (seq % n_customers) + 1
            pid = (seq % n_products) + 1
            qty = (seq % 20) + 1
            total = round(10.0 + (seq * 13) % 490, 2)
            seq += 1

            t0 = time.monotonic()
            cur.execute(INSERT_SQL, (cid, pid, qty, total))
            t1 = time.monotonic()

            latencies.append((t1 - t0) * 1_000_000)  # seconds -> microseconds

            if t1 >= deadline:
                break

        cur.close()
    finally:
        conn.close()

    elapsed = time.monotonic() - (deadline - duration_s)
    return latencies, elapsed


def _pick_query_ids(queries, n):
    """Select up to n query IDs for subscription setup.

    Uses Q1..Q8 in order. If more than 8 are needed, wraps around and
    creates aliased IDs (e.g. Q1_2, Q2_2) to avoid collisions.

    Args:
        queries: Dict of {qid: sql} from queries.sql.
        n: Number of subscriptions desired.

    Returns:
        List of (query_id, query_sql) tuples of length n.
    """
    base_ids = sorted(qid for qid in queries if qid.startswith("Q"))
    result = []
    for i in range(n):
        idx = i % len(base_ids)
        wrap = i // len(base_ids)
        qid = base_ids[idx]
        sql = queries[qid]
        if wrap > 0:
            # Alias the ID so the adapter sees a distinct subscription
            alias = f"{qid}_{wrap + 1}"
            result.append((alias, sql))
        else:
            result.append((qid, sql))
    return result


def _setup_subscriptions(adapter, conn, query_pairs):
    """Setup subscriptions for a list of (query_id, query_sql) pairs.

    Skips queries not supported by the adapter.

    Args:
        adapter: BenchApproach instance.
        conn: psycopg2 connection (autocommit=False is fine; we commit after).
        query_pairs: List of (query_id, query_sql) tuples.

    Returns:
        List of query_ids that were successfully subscribed.
    """
    subscribed = []
    old_autocommit = conn.autocommit
    conn.autocommit = False
    for qid, sql in query_pairs:
        # Check support using the base query ID (strip alias suffix)
        base_qid = qid.split("_")[0] if "_" in qid and qid.split("_")[-1].isdigit() else qid
        if not adapter.supports_query(base_qid):
            continue
        try:
            adapter.setup(conn, qid, sql)
            conn.commit()
            subscribed.append(qid)
        except Exception as exc:
            conn.rollback()
            print(f"  WARNING: setup failed for {adapter.name}/{qid}: {exc}",
                  file=sys.stderr)
    conn.autocommit = old_autocommit
    return subscribed


def _teardown_subscriptions(adapter, conn, subscribed_ids):
    """Teardown all previously subscribed queries.

    Args:
        adapter: BenchApproach instance.
        conn: psycopg2 connection.
        subscribed_ids: List of query_ids to unsubscribe.
    """
    old_autocommit = conn.autocommit
    conn.autocommit = False
    for qid in subscribed_ids:
        try:
            adapter.teardown(conn, qid)
            conn.commit()
        except Exception as exc:
            conn.rollback()
            print(f"  WARNING: teardown failed for {adapter.name}/{qid}: {exc}",
                  file=sys.stderr)
    conn.autocommit = old_autocommit


def run(adapters, queries, connect_fn, params, duration):
    """Execute the S1 write-overhead benchmark scenario.

    Args:
        adapters: List of BenchApproach instances to benchmark.
        queries: Dict of {qid: sql} loaded from queries.sql.
        connect_fn: Callable returning a psycopg2 connection.
                    Accepts autocommit keyword argument.
        params: Dict of scenario-specific parameters (unused by S1).
        duration: Benchmark duration in seconds per measurement.

    Returns:
        JSON-serializable dict with baseline and per-adapter results.
    """
    # Discover table sizes for cycling IDs
    setup_conn = connect_fn()
    n_customers, n_products = _get_table_counts(setup_conn)
    setup_conn.close()

    print(f"Table sizes: {n_customers} customers, {n_products} products")
    print(f"Duration per measurement: {duration}s")
    print()

    # --- Phase 1: Baseline (no subscriptions) ---
    print("--- Baseline (0 subscriptions) ---")
    latencies, elapsed = _run_insert_workload(
        connect_fn, duration, n_customers, n_products
    )
    baseline = _compute_stats(latencies, elapsed)
    print(f"  Baseline: {baseline['tps']:.0f} TPS, "
          f"p50={baseline['p50_us']:.0f}us, "
          f"p95={baseline['p95_us']:.0f}us, "
          f"p99={baseline['p99_us']:.0f}us "
          f"({baseline['total_ops']} ops)")
    print()

    baseline_tps = baseline["tps"]

    # --- Phase 2: Per-adapter measurements ---
    results = []
    for adapter in adapters:
        print(f"--- {adapter.name} ---")
        adapter_result = {"approach": adapter.name, "levels": {}}

        for level in SUBSCRIPTION_LEVELS:
            query_pairs = _pick_query_ids(queries, level)

            mgmt_conn = connect_fn()
            subscribed = _setup_subscriptions(adapter, mgmt_conn, query_pairs)
            actual_level = len(subscribed)

            if actual_level == 0:
                print(f"  {adapter.name} @ {level} subs: SKIPPED (no queries supported)")
                mgmt_conn.close()
                continue

            print(f"  {adapter.name} @ {actual_level} subs: running... ", end="")
            sys.stdout.flush()

            latencies, elapsed = _run_insert_workload(
                connect_fn, duration, n_customers, n_products
            )
            stats = _compute_stats(latencies, elapsed)

            overhead = (
                (baseline_tps - stats["tps"]) / baseline_tps * 100.0
                if baseline_tps > 0
                else 0.0
            )
            stats["overhead_pct"] = round(overhead, 2)

            sign = "+" if overhead >= 0 else ""
            print(f"{stats['tps']:.0f} TPS (overhead: {sign}{overhead:.1f}%), "
                  f"p50={stats['p50_us']:.0f}us, "
                  f"p95={stats['p95_us']:.0f}us, "
                  f"p99={stats['p99_us']:.0f}us "
                  f"({stats['total_ops']} ops)")

            adapter_result["levels"][str(actual_level)] = stats

            _teardown_subscriptions(adapter, mgmt_conn, subscribed)
            mgmt_conn.close()

        results.append(adapter_result)
        print()

    return {
        "scenario": "s1_write_overhead",
        "duration_s": duration,
        "baseline": baseline,
        "results": results,
    }
