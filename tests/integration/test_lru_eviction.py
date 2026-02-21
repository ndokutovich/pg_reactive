#!/usr/bin/env python3
"""
LRU eviction test: fills subscriptions to max_subscriptions capacity,
then adds one more and verifies the oldest subscription was evicted.

Usage:
  # Restart PG with low max_subscriptions, then run:
  docker compose exec -T db bash -c \
    'cd /ext/ext && make install' && \
  docker compose stop db && \
  docker compose run --rm -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_HOST_AUTH_METHOD=trust db \
    postgres -c shared_preload_libraries=pg_reactive \
    -c pg_reactive.max_subscriptions=5 &
  sleep 10
  docker compose exec -T db python3 /ext/tests/integration/test_lru_eviction.py

Or simply run inside a container that has max_subscriptions set low:
  python3 /ext/tests/integration/test_lru_eviction.py
"""

import sys
import time
import psycopg2

DB = "postgres"
USER = "postgres"


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def psql(conn, sql, fetch=False):
    cur = conn.cursor()
    cur.execute(sql)
    if fetch:
        rows = cur.fetchall()
        cur.close()
        return rows
    cur.close()
    return None


def main():
    conn = connect()
    conn.autocommit = True

    # Get max_subscriptions
    rows = psql(conn, "SHOW pg_reactive.max_subscriptions", fetch=True)
    max_subs = int(rows[0][0])
    print(f"max_subscriptions = {max_subs}")

    if max_subs > 50:
        print(f"SKIP: max_subscriptions={max_subs} is too high for eviction test.")
        print("Restart with pg_reactive.max_subscriptions=5 to test eviction.")
        sys.exit(0)

    # Setup
    psql(conn, "CREATE EXTENSION IF NOT EXISTS pg_reactive")
    psql(conn, "CREATE TABLE IF NOT EXISTS lru_test (id serial PRIMARY KEY, val text)")
    psql(conn, "INSERT INTO lru_test (val) SELECT 'row' || i FROM generate_series(1,5) i")

    # Clean up any existing subscriptions
    existing = psql(conn, "SELECT query_id FROM pgr.get_subscriptions()", fetch=True)
    for row in existing:
        psql(conn, f"SELECT pgr.unsubscribe('{row[0]}')")

    # Fill to capacity
    print(f"Filling {max_subs} subscriptions...")
    for i in range(1, max_subs + 1):
        qid = f"lru_q{i}"
        psql(conn, f"SELECT pgr.subscribe('{qid}', 'SELECT id, val FROM lru_test')")
        # Small delay to ensure distinct subscribed_at timestamps
        if i <= 2:
            time.sleep(0.01)

    # Verify count
    rows = psql(conn, "SELECT value FROM pgr.stats() WHERE metric = 'active_subscriptions'", fetch=True)
    active = int(rows[0][0])
    assert active == max_subs, f"Expected {max_subs} active, got {active}"
    print(f"  Active subscriptions: {active} (at capacity)")

    # Get eviction count before
    rows = psql(conn, "SELECT value FROM pgr.stats() WHERE metric = 'total_evictions'", fetch=True)
    evictions_before = int(rows[0][0])

    # Add one more — should evict the oldest (lru_q1)
    print("Adding subscription beyond capacity (should evict oldest)...")
    psql(conn, "SELECT pgr.subscribe('lru_overflow', 'SELECT id FROM lru_test')")

    # Verify eviction count increased
    rows = psql(conn, "SELECT value FROM pgr.stats() WHERE metric = 'total_evictions'", fetch=True)
    evictions_after = int(rows[0][0])
    assert evictions_after == evictions_before + 1, \
        f"Expected eviction_count={evictions_before + 1}, got {evictions_after}"
    print(f"  Evictions: {evictions_before} -> {evictions_after}")

    # Verify active count is still at max (oldest evicted, new one added)
    rows = psql(conn, "SELECT value FROM pgr.stats() WHERE metric = 'active_subscriptions'", fetch=True)
    active = int(rows[0][0])
    assert active == max_subs, f"Expected {max_subs} active after eviction, got {active}"

    # Verify the oldest (lru_q1) was evicted
    rows = psql(conn, "SELECT query_id FROM pgr.get_subscriptions() WHERE query_id = 'lru_q1'", fetch=True)
    assert len(rows) == 0, "lru_q1 should have been evicted but is still present"
    print("  lru_q1 correctly evicted")

    # Verify the new subscription exists
    rows = psql(conn, "SELECT query_id FROM pgr.get_subscriptions() WHERE query_id = 'lru_overflow'", fetch=True)
    assert len(rows) == 1, "lru_overflow should exist after eviction"
    print("  lru_overflow correctly added")

    # Verify snapshot table for evicted query was dropped
    rows = psql(conn, """
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'pgr' AND table_name = '_snap_lru_q1'
    """, fetch=True)
    assert len(rows) == 0, "Snapshot for evicted query should be dropped"
    print("  Snapshot for lru_q1 correctly dropped")

    # Cleanup
    existing = psql(conn, "SELECT query_id FROM pgr.get_subscriptions()", fetch=True)
    for row in existing:
        psql(conn, f"SELECT pgr.unsubscribe('{row[0]}')")
    psql(conn, "DROP TABLE IF EXISTS lru_test")
    psql(conn, "DROP EXTENSION pg_reactive")

    conn.close()
    print("\nAll LRU eviction tests passed!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
