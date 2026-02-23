#!/usr/bin/env python3
"""
P1: Write throughput vs subscription count.

Measures how synchronous trigger-based recompute affects INSERT TPS
as the number of active subscriptions increases.

Usage (inside container):
  python3 /ext/tests/perf/p1_write_throughput.py
"""

import sys
import time
import psycopg2

DB = "pg_reactive_test"
USER = "postgres"

SEED_ROWS = 5000
DURATION_SECONDS = 15
LEVELS = [0, 1, 5, 10, 25, 50]

# Thresholds: (level, fail_p50_ms, warn_p50_ms) — absolute latency limits
THRESHOLDS = {
    1: (20, 10),      # 1-sub: p50 < 20ms (FAIL), < 10ms (WARN)
    5: (50, 20),      # 5-sub: p50 < 50ms
    10: (100, 50),    # 10-sub: p50 < 100ms
}


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def percentile(sorted_values, pct):
    idx = int(len(sorted_values) * pct / 100)
    return sorted_values[min(idx, len(sorted_values) - 1)]


def run_level(conn, level, next_val):
    """Run single-row INSERTs for DURATION_SECONDS and collect latencies.

    Returns (latencies_list, next_val_after).
    """
    latencies = []
    deadline = time.monotonic() + DURATION_SECONDS
    cur = conn.cursor()

    while time.monotonic() < deadline:
        t0 = time.monotonic()
        cur.execute("INSERT INTO p1_data (val) VALUES (%s)", (next_val,))
        elapsed = time.monotonic() - t0
        latencies.append(elapsed)
        next_val += 1

    cur.close()
    return latencies, next_val


def subscribe_level(conn, level):
    """Create `level` subscriptions with varied WHERE clauses."""
    cur = conn.cursor()
    for i in range(level):
        cur.execute(
            "SELECT pgr.subscribe(%s, %s)",
            (
                "p1_q_{}".format(i),
                "SELECT id, val FROM p1_data WHERE val % {} = {} ORDER BY id DESC LIMIT 100".format(
                    max(level, 1), i
                ),
            ),
        )
    cur.close()


def unsubscribe_level(conn, level):
    """Remove all subscriptions from a level."""
    cur = conn.cursor()
    for i in range(level):
        cur.execute("SELECT pgr.unsubscribe(%s)", ("p1_q_{}".format(i),))
    cur.close()


def main():
    conn = connect()
    conn.autocommit = True

    try:
        # Setup
        cur = conn.cursor()
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
        cur.execute("DROP TABLE IF EXISTS p1_data CASCADE")
        cur.execute("CREATE TABLE p1_data (id serial PRIMARY KEY, val int)")
        cur.execute(
            "INSERT INTO p1_data (val) SELECT g FROM generate_series(1, %s) g",
            (SEED_ROWS,),
        )
        cur.close()

        next_val = SEED_ROWS + 1
        results = {}
        baseline_tps = None
        prev_level = 0

        print("=== P1: Write Throughput vs Subscription Count ===")

        for level in LEVELS:
            # Transition subscriptions
            if prev_level > 0:
                unsubscribe_level(conn, prev_level)
            if level > 0:
                subscribe_level(conn, level)

            latencies, next_val = run_level(conn, level, next_val)
            latencies.sort()

            tps = len(latencies) / DURATION_SECONDS
            p50 = percentile(latencies, 50) * 1000
            p95 = percentile(latencies, 95) * 1000
            p99 = percentile(latencies, 99) * 1000

            results[level] = {
                "tps": tps,
                "p50": p50,
                "p95": p95,
                "p99": p99,
                "count": len(latencies),
            }

            if level == 0:
                baseline_tps = tps
                print(
                    "Level 0 (baseline): TPS={:<8.1f} p50={:.2f}ms  "
                    "p95={:.2f}ms  p99={:.2f}ms".format(tps, p50, p95, p99)
                )
            else:
                overhead = ((baseline_tps - tps) / baseline_tps) * 100
                results[level]["overhead"] = overhead
                print(
                    "Level {:>2} subs:      TPS={:<8.1f} p50={:.2f}ms  "
                    "p95={:.2f}ms  p99={:.2f}ms  overhead=+{:.0f}%".format(
                        level, tps, p50, p95, p99, overhead
                    )
                )

            prev_level = level

        # Cleanup subscriptions from last level
        if prev_level > 0:
            unsubscribe_level(conn, prev_level)

        # Evaluate thresholds (absolute latency)
        print("\n--- Thresholds ---")
        passed = True

        for level, (fail_ms, warn_ms) in sorted(THRESHOLDS.items()):
            p50 = results[level]["p50"]
            if p50 > fail_ms:
                status = "FAIL"
                passed = False
            elif p50 > warn_ms:
                status = "WARN"
            else:
                status = "PASS"
            print(
                "{}-sub p50: {:.1f}ms [{}] (< {}ms)".format(
                    level, p50, status, fail_ms
                )
            )

        if passed:
            print("\n=== P1: PASS ===")
        else:
            print("\n=== P1: FAIL ===")
            sys.exit(1)

    finally:
        # Cleanup even on error
        cleanup = connect()
        cleanup.autocommit = True
        cleanup_cur = cleanup.cursor()
        try:
            # Unsubscribe anything leftover
            cleanup_cur.execute(
                "SELECT query_id FROM pgr.get_subscriptions() "
                "WHERE query_id LIKE 'p1_q_%'"
            )
            for row in cleanup_cur.fetchall():
                cleanup_cur.execute(
                    "SELECT pgr.unsubscribe(%s)", (row[0],)
                )
        except Exception:
            pass
        try:
            cleanup_cur.execute("DROP TABLE IF EXISTS p1_data CASCADE")
        except Exception:
            pass
        cleanup_cur.close()
        cleanup.close()
        conn.close()


if __name__ == "__main__":
    main()
