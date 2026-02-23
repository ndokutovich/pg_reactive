"""
S4: Result Set Scale — measures how performance degrades with larger result sets.

Uses Q3 (all order details via inner JOIN) whose result size is proportional
to the orders table scale.  For each adapter that supports Q3 we measure:

  - snapshot_rows: row count from an initial read_current
  - delivery_latency: p50/p95/p99 over 20 INSERT-then-wait iterations
  - write_tps: sustained write throughput during a timed burst

Only pgr, ivm, and poll are tested (CDC approaches skip this scenario).
"""

import sys
import time


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _percentiles(sorted_values, pcts):
    """Return dict {pct: value} from a pre-sorted list of floats."""
    n = len(sorted_values)
    if n == 0:
        return {p: 0.0 for p in pcts}
    result = {}
    for p in pcts:
        k = (p / 100.0) * (n - 1)
        lo = int(k)
        hi = min(lo + 1, n - 1)
        frac = k - lo
        result[p] = sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac
    return result


def _us(seconds):
    """Convert seconds to microseconds (float)."""
    return seconds * 1_000_000


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(adapters, queries, connect_fn, params, duration):
    """Execute the S4 result-set-scale scenario.

    Args:
        adapters: list of BenchApproach instances.
        queries: dict mapping query ID to SQL text.
        connect_fn: callable(autocommit=bool) -> psycopg2 connection.
        params: dict of harness parameters; may contain ``scale``.
        duration: int, seconds for the TPS burst phase.

    Returns:
        dict with scenario results (JSON-serialisable).
    """
    scale = int(params.get("scale", "100"))
    query_id = "Q3"
    query_sql = queries[query_id]

    # Discover table sizes for cycling INSERT values.
    meta_conn = connect_fn(autocommit=True)
    with meta_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM customers")
        n_customers = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM products")
        n_products = cur.fetchone()[0]
    meta_conn.close()

    print(f"[s4] scale={scale}  customers={n_customers}  products={n_products}")

    results = []

    for adapter in adapters:
        if not adapter.supports_query(query_id):
            print(f"[s4] {adapter.name}: skipping (Q3 not supported)")
            continue

        print(f"[s4] {adapter.name}: setting up subscription for {query_id} ...")

        # --- Setup -----------------------------------------------------------
        setup_conn = connect_fn(autocommit=True)
        try:
            adapter.setup(setup_conn, query_id, query_sql)
        except Exception as exc:
            print(f"[s4] {adapter.name}: setup failed: {exc}", file=sys.stderr)
            setup_conn.close()
            continue

        # Prepare listener (for push-based adapters).
        listener_conn = connect_fn(autocommit=True)
        adapter.setup_listener(listener_conn, query_id)

        # --- Snapshot size ---------------------------------------------------
        read_conn = connect_fn(autocommit=True)
        try:
            rows = adapter.read_current(read_conn, query_id, query_sql)
            snapshot_rows = len(rows) if rows else 0
        except Exception:
            snapshot_rows = -1
        print(f"[s4] {adapter.name}: snapshot_rows={snapshot_rows}")

        # --- Delivery latency (20 iterations) --------------------------------
        write_conn = connect_fn(autocommit=True)
        latencies_us = []
        insert_counter = 0

        for i in range(20):
            cid = (insert_counter % n_customers) + 1
            pid = (insert_counter % n_products) + 1
            qty = 1 + (insert_counter % 20)
            total = round(10 + (insert_counter * 13) % 490, 2)
            insert_counter += 1

            t0 = time.monotonic()
            with write_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO orders (customer_id, product_id, qty, total) "
                    "VALUES (%s, %s, %s, %s)",
                    (cid, pid, qty, total),
                )

            # Wait for the adapter to observe the change.
            result = adapter.wait_for_change(listener_conn, query_id, timeout_s=5.0)
            t1 = time.monotonic()

            if result and result.get("received"):
                latencies_us.append(_us(t1 - t0))
            else:
                # Timeout — still record it so the picture is honest.
                latencies_us.append(_us(5.0))

            if (i + 1) % 5 == 0:
                print(f"[s4] {adapter.name}: latency iter {i + 1}/20 done")

        latencies_us.sort()
        pcts = _percentiles(latencies_us, [50, 95, 99])

        # --- TPS burst -------------------------------------------------------
        print(f"[s4] {adapter.name}: starting {duration}s TPS burst ...")
        ops = 0
        burst_start = time.monotonic()
        deadline = burst_start + duration

        while time.monotonic() < deadline:
            cid = (insert_counter % n_customers) + 1
            pid = (insert_counter % n_products) + 1
            qty = 1 + (insert_counter % 20)
            total = round(10 + (insert_counter * 13) % 490, 2)
            insert_counter += 1

            with write_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO orders (customer_id, product_id, qty, total) "
                    "VALUES (%s, %s, %s, %s)",
                    (cid, pid, qty, total),
                )
            ops += 1

        elapsed = time.monotonic() - burst_start
        write_tps = ops / elapsed if elapsed > 0 else 0.0
        print(f"[s4] {adapter.name}: TPS burst done — {ops} ops in {elapsed:.1f}s = {write_tps:.1f} TPS")

        # --- Teardown --------------------------------------------------------
        try:
            adapter.teardown(setup_conn, query_id)
        except Exception as exc:
            print(f"[s4] {adapter.name}: teardown warning: {exc}", file=sys.stderr)

        for c in (write_conn, listener_conn, read_conn, setup_conn):
            try:
                c.close()
            except Exception:
                pass

        results.append({
            "approach": adapter.name,
            "snapshot_rows": snapshot_rows,
            "delivery_latency": {
                "p50_us": round(pcts[50], 1),
                "p95_us": round(pcts[95], 1),
                "p99_us": round(pcts[99], 1),
            },
            "write_tps": round(write_tps, 2),
        })

    return {
        "scenario": "s4_result_set_scale",
        "scale": scale,
        "query": query_id,
        "results": results,
    }
