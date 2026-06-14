#!/usr/bin/env python3
"""FR-R.12 — optional async-recompute background worker.

Must run against a PostgreSQL started with the worker enabled:

    postgres -c shared_preload_libraries=pg_reactive \
             -c pg_reactive.async_recompute=on \
             -c pg_reactive.database=pg_reactive_test

(the worker is PGC_POSTMASTER + off by default, so it cannot be exercised by
the normal dev stack or pg_regress — see CLAUDE.md / bgworker.c). This test
asserts:

  1. pg_reactive.async_recompute = on and a 'pg_reactive worker' backend is
     connected (the worker registered at postmaster start and attached to the
     configured database);
  2. a subscribed query still receives a delta NOTIFY after a write — proving
     the worker drained the dirty queue and recomputed out-of-band. In async
     mode the AFTER-STATEMENT trigger only enqueues the dirty table + SetLatch()
     es the worker (invalidation.c); it does NOT recompute inline, so a delta
     arriving is end-to-end proof the worker did the work.

Run it inside the throwaway container:
    docker exec <c> python3 /ext/tests/integration/test_async_recompute.py
"""
import json
import os
import select
import sys
import time

import psycopg2

CONN = dict(
    host=os.environ.get("PGHOST", "127.0.0.1"),
    port=int(os.environ.get("PGPORT", "5432")),
    dbname=os.environ.get("PGDATABASE", "pg_reactive_test"),
    user=os.environ.get("PGUSER", "postgres"),
    password=os.environ.get("PGPASSWORD", "postgres"),
)

fail = 0


def check(ok, msg):
    global fail
    print(("  PASS " if ok else "  FAIL ") + msg)
    if not ok:
        fail += 1


print("=== FR-R.12 async-recompute background worker ===")
conn = psycopg2.connect(**CONN)
conn.autocommit = True
cur = conn.cursor()

# 1) GUC on + worker backend connected
cur.execute("SHOW pg_reactive.async_recompute")
check(cur.fetchone()[0] == "on", "pg_reactive.async_recompute = on")

workers = 0
for _ in range(30):  # worker attaches shortly after postmaster start
    cur.execute(
        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'pg_reactive worker'"
    )
    workers = cur.fetchone()[0]
    if workers >= 1:
        break
    time.sleep(0.5)
check(workers >= 1, f"'pg_reactive worker' backend connected (found {workers})")

# 2) functional async recompute via the worker
cur.execute("DROP TABLE IF EXISTS bgw_items CASCADE")
cur.execute("CREATE TABLE bgw_items (id int PRIMARY KEY, val text)")
cur.execute("INSERT INTO bgw_items VALUES (1, 'a')")
cur.execute(
    "SELECT pgr.subscribe('bgw_async_q', 'SELECT id, val FROM bgw_items ORDER BY id')"
)

listen = psycopg2.connect(**CONN)
listen.autocommit = True
lc = listen.cursor()
lc.execute("LISTEN pgr")

# Write AFTER LISTEN is established so we can't miss the notification.
cur.execute("INSERT INTO bgw_items VALUES (2, 'b')")

got = None
deadline = time.time() + 15
while time.time() < deadline and got is None:
    if select.select([listen], [], [], 1.0)[0]:
        listen.poll()
        while listen.notifies:
            n = listen.notifies.pop(0)
            try:
                payload = json.loads(n.payload)
            except (ValueError, TypeError):
                continue
            if payload.get("query_id") == "bgw_async_q" and payload.get("inserted"):
                got = payload
                break

check(got is not None, "async delta NOTIFY delivered for bgw_async_q after the write")
if got:
    check(
        any(r.get("id") == 2 for r in got["inserted"]),
        "delta carried the inserted row (id=2)",
    )

# cleanup (best effort)
try:
    cur.execute("SELECT pgr.unsubscribe('bgw_async_q')")
    cur.execute("DROP TABLE IF EXISTS bgw_items CASCADE")
except Exception:
    pass

print(("\nFAIL" if fail else "\nPASS") + f": async-recompute background worker ({fail} failure(s))")
sys.exit(1 if fail else 0)
