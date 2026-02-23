#!/usr/bin/env python3
"""
P2: Snapshot size stress test — measure recompute latency vs result set size.

EXCEPT-based delta is O(N) where N = result set size, so large snapshots
should produce measurably slower recompute times.

Usage (inside container):
  python3 /ext/tests/perf/p2_snapshot_stress.py
"""

import sys
import time
import json
import select
import psycopg2

DB = "pg_reactive_test"
USER = "postgres"

SIZES = [100, 1000, 5000, 10000, 50000, 100000]
INSERTS_PER_SIZE = 10
NOTIFY_TIMEOUT = 30


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def percentile(sorted_values, pct):
    idx = int(len(sorted_values) * pct / 100)
    return sorted_values[min(idx, len(sorted_values) - 1)]


def fmt_size(nbytes):
    if nbytes >= 1024 * 1024:
        return f"{nbytes / (1024 * 1024):.1f}MB"
    return f"{nbytes // 1024}KB"


def drain_notifications(listener):
    """Drain any stale notifications from the listener."""
    listener.poll()
    while listener.notifies:
        listener.notifies.pop(0)


def wait_for_notify(listener, query_id, timeout):
    """Wait for a pgr notification matching query_id. Returns True if received."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        if select.select([listener], [], [], min(remaining, 0.5)) != ([], [], []):
            listener.poll()
        else:
            listener.poll()
        while listener.notifies:
            n = listener.notifies.pop(0)
            if n.channel == "pgr":
                try:
                    payload = json.loads(n.payload)
                except (json.JSONDecodeError, TypeError):
                    continue
                if payload.get("query_id") == query_id:
                    return True
    return False


def wait_for_raw_notify(listener, timeout):
    """Wait for any notification on pgr_raw channel. Returns True if received."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        if select.select([listener], [], [], min(remaining, 0.5)) != ([], [], []):
            listener.poll()
        else:
            listener.poll()
        while listener.notifies:
            n = listener.notifies.pop(0)
            if n.channel == "pgr_raw":
                return True
    return False


def run_size_raw(n):
    """Run raw NOTIFY latency test for a given result set size (no EXCEPT).
    Returns sorted latencies in ms.
    """
    writer = connect()
    writer.autocommit = True
    listener = connect()
    listener.autocommit = True

    try:
        with writer.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS p2_raw_data CASCADE")
            cur.execute(
                "CREATE TABLE p2_raw_data (id serial PRIMARY KEY, val int, padding text)"
            )
            cur.execute(
                "INSERT INTO p2_raw_data (val, padding) "
                "SELECT g, repeat('x', 50) FROM generate_series(1, %s) g",
                (n,),
            )
            # Raw NOTIFY trigger — no EXCEPT, just pg_notify on each row
            cur.execute("""
                CREATE OR REPLACE FUNCTION p2_raw_notify() RETURNS trigger AS $$
                BEGIN PERFORM pg_notify('pgr_raw', row_to_json(NEW)::text); RETURN NEW; END;
                $$ LANGUAGE plpgsql
            """)
            cur.execute(
                "CREATE TRIGGER p2_raw_trg AFTER INSERT ON p2_raw_data "
                "FOR EACH ROW EXECUTE FUNCTION p2_raw_notify()"
            )

        with listener.cursor() as cur:
            cur.execute("LISTEN pgr_raw")

        # Wait briefly for LISTEN to register, drain any stale notifications
        time.sleep(0.1)
        drain_notifications(listener)

        # Measure latencies over INSERTS_PER_SIZE single-row inserts
        latencies = []
        for i in range(INSERTS_PER_SIZE):
            drain_notifications(listener)
            t0 = time.time()
            with writer.cursor() as cur:
                cur.execute(
                    "INSERT INTO p2_raw_data (val, padding) VALUES (%s, %s)",
                    (n + i, "y" * 50),
                )
            if wait_for_raw_notify(listener, NOTIFY_TIMEOUT):
                latencies.append((time.time() - t0) * 1000)
            else:
                latencies.append(NOTIFY_TIMEOUT * 1000)

        return sorted(latencies)

    finally:
        try:
            with writer.cursor() as cur:
                cur.execute("DROP TABLE IF EXISTS p2_raw_data CASCADE")
                cur.execute("DROP FUNCTION IF EXISTS p2_raw_notify() CASCADE")
        except Exception:
            pass
        writer.close()
        listener.close()


def run_size(n):
    """Run the stress test for a given result set size. Returns (latencies, snap_bytes)."""
    writer = connect()
    writer.autocommit = True
    listener = connect()
    listener.autocommit = True

    try:
        with writer.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
            cur.execute("DROP TABLE IF EXISTS p2_data CASCADE")
            cur.execute(
                "CREATE TABLE p2_data (id serial PRIMARY KEY, val int, padding text)"
            )
            cur.execute(
                "INSERT INTO p2_data (val, padding) "
                "SELECT g, repeat('x', 50) FROM generate_series(1, %s) g",
                (n,),
            )
            cur.execute(
                "SELECT pgr.subscribe('p2_q', 'SELECT id, val FROM p2_data')"
            )

        with listener.cursor() as cur:
            cur.execute("LISTEN pgr")

        # Wait briefly for LISTEN to register, drain any setup notifications
        time.sleep(0.1)
        drain_notifications(listener)

        # Measure latencies over INSERTS_PER_SIZE single-row inserts
        latencies = []
        for i in range(INSERTS_PER_SIZE):
            drain_notifications(listener)
            t0 = time.time()
            with writer.cursor() as cur:
                cur.execute(
                    "INSERT INTO p2_data (val, padding) VALUES (%s, %s)",
                    (n + i, "y" * 50),
                )
            if wait_for_notify(listener, "p2_q", NOTIFY_TIMEOUT):
                latencies.append((time.time() - t0) * 1000)
            else:
                latencies.append(NOTIFY_TIMEOUT * 1000)

        # Measure snapshot table size
        snap_bytes = 0
        try:
            with writer.cursor() as cur:
                cur.execute(
                    """SELECT pg_total_relation_size('pgr."_snap_p2_q"')"""
                )
                snap_bytes = cur.fetchone()[0]
        except Exception:
            pass

        return sorted(latencies), snap_bytes

    finally:
        try:
            with writer.cursor() as cur:
                cur.execute("SELECT pgr.unsubscribe('p2_q')")
                cur.execute("DROP TABLE IF EXISTS p2_data CASCADE")
        except Exception:
            pass
        writer.close()
        listener.close()


def main():
    print("=== P2: Snapshot Size Stress ===")

    results = {}
    for n in SIZES:
        latencies, snap_bytes = run_size(n)
        raw_latencies = run_size_raw(n)

        p50 = percentile(latencies, 50)
        p95 = percentile(latencies, 95)
        raw_p50 = percentile(raw_latencies, 50)

        ratio = p50 / raw_p50 if raw_p50 > 0 else float("inf")
        results[n] = (p50, p95, snap_bytes, raw_p50, ratio)

        p50_str = f"{p50:.1f}ms"
        p95_str = f"{p95:.1f}ms"
        raw_p50_str = f"{raw_p50:.1f}ms"
        snap_str = fmt_size(snap_bytes)
        print(
            f"{n:>6} rows: pgr_p50={p50_str:>9}  raw_p50={raw_p50_str:>9}  "
            f"ratio={ratio:.1f}x  snap={snap_str:>7}"
        )

    # Comparison summary
    print("--- Comparison: pgr vs raw NOTIFY ---")
    for n in SIZES:
        p50, _p95, _snap, raw_p50, _ratio = results[n]
        except_cost = p50 - raw_p50
        pct = (except_cost / p50 * 100) if p50 > 0 else 0.0
        print(
            f"{n:>6} rows: pgr={p50:.1f}ms  raw={raw_p50:.1f}ms  "
            f"EXCEPT_cost={except_cost:.1f}ms ({pct:.0f}%)"
        )

    # Threshold checks
    print("--- Thresholds ---")
    passed = True

    p50_1k = results[1000][0]
    ok_1k = p50_1k < 100
    tag_1k = "PASS" if ok_1k else "FAIL"
    print(f"1K rows p50: {p50_1k:.1f}ms [{tag_1k}] (< 100ms)")
    if not ok_1k:
        passed = False

    p50_10k = results[10000][0]
    ok_10k = p50_10k < 1500
    tag_10k = "PASS" if ok_10k else "FAIL"
    print(f"10K rows p50: {p50_10k:.1f}ms [{tag_10k}] (< 1500ms)")
    if not ok_10k:
        passed = False

    verdict = "PASS" if passed else "FAIL"
    print(f"=== P2: {verdict} ===")
    if not passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
