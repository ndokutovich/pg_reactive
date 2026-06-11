#!/usr/bin/env python3
"""
Cross-database shmem isolation — Codex round-36 finding #2.

The dependency hash lives in cluster-wide shared memory. Before the fix its
key was the bare query_id, so two databases that registered the SAME
query_id collided: the second subscribe overwrote the first, and table OIDs
(also per-database) aliased in the reverse index. The key is now
"<MyDatabaseId>/<query_id>" and every iteration filters on the owning dbid.

This test creates two databases, registers the same query_id in each with a
DIFFERENT query text, and asserts that neither overwrites the other and that
each database's pgr.get_subscriptions() returns only its own row.

Usage (inside container):
  python3 /ext/tests/integration/test_cross_db_isolation.py
"""

import sys
import psycopg2

USER = "postgres"
DB_A = "pgr_xdb_a"
DB_B = "pgr_xdb_b"
QID = "xdb_shared_id"
SQL_A = "SELECT id FROM t WHERE id < 100"
SQL_B = "SELECT id FROM t WHERE id > 900"


def admin():
    c = psycopg2.connect(dbname="postgres", user=USER)
    c.autocommit = True
    return c


def setup_db(name, query_sql):
    c = psycopg2.connect(dbname=name, user=USER)
    c.autocommit = True
    with c.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
        cur.execute("CREATE TABLE IF NOT EXISTS t (id int primary key)")
        cur.execute("SELECT pgr.subscribe(%s, %s)", (QID, query_sql))
    return c


def subscriptions(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT query_id, query_text FROM pgr.get_subscriptions() "
            "WHERE query_id = %s ORDER BY query_text",
            (QID,),
        )
        return cur.fetchall()


def main():
    a = admin()
    with a.cursor() as cur:
        for db in (DB_A, DB_B):
            cur.execute(f"DROP DATABASE IF EXISTS {db}")
            cur.execute(f"CREATE DATABASE {db}")

    failures = []
    try:
        ca = setup_db(DB_A, SQL_A)
        cb = setup_db(DB_B, SQL_B)

        rows_a = subscriptions(ca)
        rows_b = subscriptions(cb)

        # Each database must see exactly ONE row for the shared id, and it
        # must be ITS OWN query text — not the other database's.
        if rows_a != [(QID, SQL_A)]:
            failures.append(f"DB_A sees {rows_a}, expected [('{QID}', '{SQL_A}')]")
        if rows_b != [(QID, SQL_B)]:
            failures.append(f"DB_B sees {rows_b}, expected [('{QID}', '{SQL_B}')]")

        ca.close()
        cb.close()
    finally:
        with a.cursor() as cur:
            for db in (DB_A, DB_B):
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()",
                    (db,),
                )
                cur.execute(f"DROP DATABASE IF EXISTS {db}")
        a.close()

    if failures:
        print("FAIL: cross-database shmem isolation broken")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("PASS: same query_id in two databases stays isolated")


if __name__ == "__main__":
    main()
