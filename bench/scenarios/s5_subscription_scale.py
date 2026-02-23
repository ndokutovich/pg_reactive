"""
S5: Subscription Scale — measures throughput with N active subscriptions.

For each adapter and each subscription level (0, 1, 5, 10, 25, 50) we:

  1. Register N subscriptions (cycling through Q1..Q8 and duplicating as needed).
  2. Run an INSERT workload for ``duration`` seconds, recording TPS and latency.
  3. Teardown all subscriptions.

Level 0 is a pure baseline with no active subscriptions.

Notes on adapter limits:
  - pg_reactive supports arbitrary duplicate subscriptions (each call gets a
    unique query_id like "Q1_dup3").
  - pg_ivm cannot have duplicate IMMVs with the same name, so we generate
    unique view names.  It also only supports Q1-Q4, so the practical ceiling
    is lower.  We cap pg_ivm at 25 subs and skip higher levels gracefully.
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


SUB_LEVELS = [0, 1, 5, 10, 25, 50]

# Maximum subscription count per adapter (to avoid extreme slowness).
ADAPTER_CAPS = {
    "pg_ivm": 25,
}


# ---------------------------------------------------------------------------
# Subscription plan builder
# ---------------------------------------------------------------------------

def _build_sub_plan(adapter, queries, n):
    """Return a list of (query_id, query_sql) tuples to register.

    We cycle through the adapter's supported queries.  When N exceeds the
    number of distinct queries, we create duplicates with suffixed IDs
    (e.g. ``Q1_dup1``, ``Q1_dup2``) so each subscription is unique.
    """
    supported = [qid for qid in sorted(queries.keys()) if adapter.supports_query(qid)]
    if not supported:
        return []

    plan = []
    dup_counter = {}  # qid -> next dup number

    for i in range(n):
        base_qid = supported[i % len(supported)]
        cycle = i // len(supported)

        if cycle == 0:
            sub_id = base_qid
        else:
            dup_counter.setdefault(base_qid, 0)
            dup_counter[base_qid] += 1
            sub_id = f"{base_qid}_dup{dup_counter[base_qid]}"

        plan.append((sub_id, queries[base_qid]))

    return plan


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(adapters, queries, connect_fn, params, duration):
    """Execute the S5 subscription-scale scenario.

    Args:
        adapters: list of BenchApproach instances.
        queries: dict mapping query ID to SQL text.
        connect_fn: callable(autocommit=bool) -> psycopg2 connection.
        params: dict of harness parameters (unused by this scenario).
        duration: int, seconds for each TPS measurement burst.

    Returns:
        dict with scenario results (JSON-serialisable).
    """
    # Discover table sizes for cycling INSERT values.
    meta_conn = connect_fn(autocommit=True)
    with meta_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM customers")
        n_customers = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM products")
        n_products = cur.fetchone()[0]
    meta_conn.close()

    print(f"[s5] customers={n_customers}  products={n_products}  duration={duration}s")

    results = []

    for adapter in adapters:
        adapter_cap = ADAPTER_CAPS.get(adapter.name, max(SUB_LEVELS))
        measurements = []

        print(f"\n[s5] === {adapter.name} ===")

        for level in SUB_LEVELS:
            effective_level = min(level, adapter_cap)
            if effective_level < level:
                print(f"[s5] {adapter.name}: capping subs at {effective_level} (adapter limit)")

            # ------ Setup subscriptions --------------------------------------
            plan = _build_sub_plan(adapter, queries, effective_level)
            setup_conn = connect_fn(autocommit=True)
            registered = []

            if effective_level > 0:
                print(f"[s5] {adapter.name}: registering {len(plan)} subscriptions (level={level}) ...")
                for sub_id, sub_sql in plan:
                    try:
                        adapter.setup(setup_conn, sub_id, sub_sql)
                        registered.append(sub_id)
                    except Exception as exc:
                        print(
                            f"[s5] {adapter.name}: setup failed for {sub_id}: {exc}",
                            file=sys.stderr,
                        )
                        # If we cannot register, stop trying more at this level.
                        break
                print(f"[s5] {adapter.name}: {len(registered)} subscriptions active")
            else:
                print(f"[s5] {adapter.name}: baseline (0 subscriptions)")

            # ------ TPS burst ------------------------------------------------
            write_conn = connect_fn(autocommit=True)
            insert_counter = 0
            ops = 0
            latencies_us = []

            burst_start = time.monotonic()
            deadline = burst_start + duration

            while time.monotonic() < deadline:
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
                t1 = time.monotonic()

                latencies_us.append(_us(t1 - t0))
                ops += 1

            elapsed = time.monotonic() - burst_start
            tps = ops / elapsed if elapsed > 0 else 0.0

            latencies_us.sort()
            pcts = _percentiles(latencies_us, [50, 95, 99])

            print(
                f"[s5] {adapter.name}: subs={len(registered)}  "
                f"TPS={tps:.1f}  ops={ops}  "
                f"p50={pcts[50]:.0f}us  p95={pcts[95]:.0f}us  p99={pcts[99]:.0f}us"
            )

            write_conn.close()

            # ------ Teardown subscriptions -----------------------------------
            for sub_id in reversed(registered):
                try:
                    adapter.teardown(setup_conn, sub_id)
                except Exception as exc:
                    print(
                        f"[s5] {adapter.name}: teardown warning for {sub_id}: {exc}",
                        file=sys.stderr,
                    )

            setup_conn.close()

            measurements.append({
                "subs": len(registered),
                "subs_requested": level,
                "tps": round(tps, 2),
                "p50_us": round(pcts[50], 1),
                "p95_us": round(pcts[95], 1),
                "p99_us": round(pcts[99], 1),
            })

        results.append({
            "approach": adapter.name,
            "measurements": measurements,
        })

    return {
        "scenario": "s5_subscription_scale",
        "levels": SUB_LEVELS,
        "results": results,
    }
