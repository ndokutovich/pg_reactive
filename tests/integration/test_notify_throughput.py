#!/usr/bin/env python3
"""
NOTIFY throughput test: rapid-fire DML and verify notification delivery.

Usage (inside container):
  python3 /ext/tests/integration/test_notify_throughput.py

Listens on 'pgr' channel, fires N inserts, counts notifications received.
Target: 95%+ delivery rate.
"""

import sys
import time
import select
import psycopg2

DB = "pg_reactive_test"
USER = "postgres"

NUM_WRITES = 200  # Reduced from 1000 for sync recompute (slow per-write)
DELIVERY_TARGET = 0.95
TIMEOUT_SECONDS = 60


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def main():
    print("=== NOTIFY Throughput Test ===")

    # Writer connection (autocommit for immediate NOTIFY)
    writer = connect()
    writer.autocommit = True

    # Listener connection
    listener = connect()
    listener.autocommit = True

    # Setup
    with writer.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
        cur.execute("DROP TABLE IF EXISTS throughput_data CASCADE")
        cur.execute("CREATE TABLE throughput_data (id serial PRIMARY KEY, val int)")
        cur.execute("""
            SELECT pgr.subscribe(
                'throughput_q',
                'SELECT id, val FROM throughput_data'
            )
        """)

    print(f"1. Subscribed 'throughput_q', firing {NUM_WRITES} inserts")

    # Start listening
    with listener.cursor() as cur:
        cur.execute("LISTEN pgr")

    # Fire writes
    start = time.time()
    for i in range(NUM_WRITES):
        with writer.cursor() as cur:
            cur.execute(
                "INSERT INTO throughput_data (val) VALUES (%s)", (i,)
            )

    write_elapsed = time.time() - start
    print(f"2. {NUM_WRITES} inserts completed in {write_elapsed:.2f}s "
          f"({NUM_WRITES / write_elapsed:.1f} writes/sec)")

    # Drain notifications with timeout
    received = 0
    overflow_count = 0
    deadline = time.time() + TIMEOUT_SECONDS

    while time.time() < deadline:
        # Check for notifications already in the buffer
        listener.poll()
        while listener.notifies:
            n = listener.notifies.pop(0)
            if n.channel == 'pgr':
                received += 1
                if 'overflow' in (n.payload or ''):
                    overflow_count += 1

        # If we've received enough, stop early
        if received >= NUM_WRITES:
            break

        # Wait for more with a short timeout
        remaining = deadline - time.time()
        if remaining <= 0:
            break

        wait_time = min(remaining, 1.0)
        if select.select([listener], [], [], wait_time) == ([], [], []):
            # Timeout — check if any notifications arrived since last check
            listener.poll()
            if not listener.notifies:
                # No new notifications for 1 second, likely done
                if received > 0:
                    break

    elapsed = time.time() - start
    delivery_rate = received / NUM_WRITES if NUM_WRITES > 0 else 0

    print(f"3. Received {received}/{NUM_WRITES} notifications "
          f"({delivery_rate:.1%}) in {elapsed:.2f}s")
    if overflow_count > 0:
        print(f"   (includes {overflow_count} overflow notifications)")

    # Cleanup
    with writer.cursor() as cur:
        cur.execute("SELECT pgr.unsubscribe('throughput_q')")
        cur.execute("DROP TABLE throughput_data CASCADE")

    writer.close()
    listener.close()

    # Evaluate
    if delivery_rate >= DELIVERY_TARGET:
        print(f"\n=== NOTIFY THROUGHPUT TEST PASSED "
              f"({delivery_rate:.1%} >= {DELIVERY_TARGET:.0%}) ===")
    else:
        print(f"\n=== NOTIFY THROUGHPUT TEST FAILED "
              f"({delivery_rate:.1%} < {DELIVERY_TARGET:.0%}) ===")
        sys.exit(1)


if __name__ == "__main__":
    main()
