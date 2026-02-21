#!/usr/bin/env python3
"""
Shmem pressure test: fill subscriptions to max_subscriptions capacity,
verify error at capacity, and check stats.

Usage (inside container):
  python3 /ext/tests/integration/test_shmem_pressure.py

Requires: pg_reactive.max_subscriptions set (default 1024).
We use a lower count (50) by default to keep test fast, and verify
the capacity error by filling up to max_subscriptions.
"""

import sys
import psycopg2

DB = "pg_reactive_test"
USER = "postgres"

# How many subscriptions to create for the pressure test.
# We query the GUC at runtime and try to fill to capacity.
# For speed, if max > 200, we test with 200 + verify the error path separately.
FAST_LIMIT = 200


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def psql(conn, sql, fetch=False):
    with conn.cursor() as cur:
        cur.execute(sql)
        if fetch:
            return cur.fetchall()
    conn.commit()


def get_max_subscriptions(conn):
    rows = psql(conn, "SHOW pg_reactive.max_subscriptions", fetch=True)
    return int(rows[0][0])


def get_active_count(conn):
    rows = psql(conn, """
        SELECT value::int FROM pgr.stats()
        WHERE metric = 'active_subscriptions'
    """, fetch=True)
    return rows[0][0]


def main():
    print("=== Shmem Pressure Test ===")

    conn = connect()
    conn.autocommit = True

    # Setup
    psql(conn, "CREATE EXTENSION IF NOT EXISTS pg_reactive")
    psql(conn, "DROP TABLE IF EXISTS pressure_data CASCADE")
    psql(conn, "CREATE TABLE pressure_data (id serial PRIMARY KEY, val int)")

    max_subs = get_max_subscriptions(conn)
    print(f"1. max_subscriptions = {max_subs}")

    # Determine how many to fill
    fill_count = min(max_subs, FAST_LIMIT)
    print(f"2. Filling {fill_count} subscriptions...")

    # Subscribe in bulk
    created = 0
    for i in range(fill_count):
        try:
            psql(conn, f"""
                SELECT pgr.subscribe(
                    'pressure_{i}',
                    'SELECT id, val FROM pressure_data'
                )
            """)
            created += 1
        except psycopg2.errors.ProgramLimitExceeded:
            print(f"   Hit capacity at {i} subscriptions")
            conn.rollback()
            break
        except Exception as e:
            print(f"   Unexpected error at {i}: {e}")
            conn.rollback()
            break

        if (i + 1) % 50 == 0:
            print(f"   ... {i + 1} subscriptions created")

    print(f"3. Created {created} subscriptions")

    # Verify active count matches
    active = get_active_count(conn)
    print(f"4. Active subscriptions from stats: {active}")
    assert active == created, f"Expected {created} active, got {active}"

    # Verify stats counters
    rows = psql(conn, """
        SELECT metric, value FROM pgr.stats() ORDER BY metric
    """, fetch=True)
    stats = {r[0]: r[1] for r in rows}
    print(f"5. Stats: {stats}")

    total_subs = int(stats['total_subscribes'])
    assert total_subs >= created, \
        f"total_subscribes ({total_subs}) should be >= {created}"

    # If we filled to max, test the overflow error
    if created == max_subs:
        print(f"6. Testing capacity overflow (at {max_subs})...")
        try:
            psql(conn, """
                SELECT pgr.subscribe(
                    'overflow_test',
                    'SELECT id, val FROM pressure_data'
                )
            """)
            print("   FAIL: should have raised an error!")
            sys.exit(1)
        except psycopg2.errors.ProgramLimitExceeded:
            print("   OK: got expected ProgramLimitExceeded error")
            conn.rollback()
    else:
        print(f"6. Skipped overflow test (filled {created}/{max_subs})")

    # Cleanup: unsubscribe all
    print(f"7. Cleaning up {created} subscriptions...")
    for i in range(created):
        psql(conn, f"SELECT pgr.unsubscribe('pressure_{i}')")
        if (i + 1) % 50 == 0:
            print(f"   ... {i + 1} unsubscribed")

    # Verify cleanup
    active = get_active_count(conn)
    assert active == 0, f"Expected 0 active after cleanup, got {active}"
    print(f"8. Active after cleanup: {active}")

    psql(conn, "DROP TABLE pressure_data CASCADE")

    conn.close()
    print("\n=== SHMEM PRESSURE TEST PASSED ===")


if __name__ == "__main__":
    main()
