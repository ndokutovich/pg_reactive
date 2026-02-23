#!/usr/bin/env python3
"""
P6: Multi-table JOIN invalidation cascade.

Measures INSERT execution time (including synchronous trigger overhead)
when a subscription uses a 3-table JOIN. The trigger fires EXCEPT-based
recompute on every DML regardless of which table was modified.

Usage (inside container):
  python3 /ext/tests/perf/p6_cascade.py
"""

import sys
import time
import random
import psycopg2

DB = "pg_reactive_test"
USER = "postgres"

INSERTS_PER_TABLE = 20
P50_THRESHOLD_MS = 1000
VARIANCE_THRESHOLD = 3.0  # JOIN queries may have high variance across tables


def connect():
    return psycopg2.connect(dbname=DB, user=USER)


def percentile(sorted_values, pct):
    idx = int(len(sorted_values) * pct / 100)
    return sorted_values[min(idx, len(sorted_values) - 1)]


def measure_table(conn, table, count):
    """Insert rows, measuring execute() time which includes trigger overhead."""
    latencies = []
    for i in range(count):
        if table == "customers":
            sql = "INSERT INTO p6_customers (name, region) VALUES ('new_cust_{}', 'east')".format(i)
        elif table == "products":
            sql = "INSERT INTO p6_products (name, price) VALUES ('new_prod_{}', {:.2f})".format(
                i, random.random() * 500
            )
        else:
            sql = "INSERT INTO p6_orders (customer_id, product_id, qty) VALUES ({}, {}, {})".format(
                random.randint(1, 500), random.randint(1, 200), random.randint(1, 20)
            )

        t0 = time.monotonic()
        with conn.cursor() as cur:
            cur.execute(sql)
        latencies.append(time.monotonic() - t0)

    return latencies


def main():
    conn = connect()
    conn.autocommit = True

    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
            cur.execute("DROP TABLE IF EXISTS p6_orders, p6_products, p6_customers CASCADE")
            cur.execute("CREATE TABLE p6_customers (id serial PRIMARY KEY, name text, region text)")
            cur.execute("CREATE TABLE p6_products (id serial PRIMARY KEY, name text, price numeric)")
            cur.execute(
                "CREATE TABLE p6_orders (id serial PRIMARY KEY, "
                "customer_id int REFERENCES p6_customers(id), "
                "product_id int REFERENCES p6_products(id), "
                "qty int, created_at timestamptz DEFAULT now())"
            )

            # Seed data
            cur.execute(
                "INSERT INTO p6_customers (name, region) "
                "SELECT 'cust_' || g, (ARRAY['east','west','north','south'])[1 + (g % 4)] "
                "FROM generate_series(1, 500) g"
            )
            cur.execute(
                "INSERT INTO p6_products (name, price) "
                "SELECT 'prod_' || g, 10 + random() * 490 FROM generate_series(1, 200) g"
            )
            cur.execute(
                "INSERT INTO p6_orders (customer_id, product_id, qty) "
                "SELECT 1 + (random() * 499)::int, 1 + (random() * 199)::int, "
                "1 + (random() * 19)::int FROM generate_series(1, 5000) g"
            )

            # Subscribe to 3-table JOIN query
            cur.execute(
                "SELECT pgr.subscribe('p6_q', "
                "'SELECT o.id, c.name AS customer, p.name AS product, "
                "o.qty, p.price, (o.qty * p.price) AS total "
                "FROM p6_orders o "
                "JOIN p6_customers c ON o.customer_id = c.id "
                "JOIN p6_products p ON o.product_id = p.id "
                "ORDER BY o.id DESC LIMIT 100')"
            )

        # Measure baseline: INSERT into orders with NO subscription
        # (already have subscription, so first measure with it)

        tables = [
            ("customers", 500),
            ("products", 200),
            ("orders", 5000),
        ]

        results = {}
        print("=== P6: Multi-Table Cascade ===")

        for table, base_rows in tables:
            lats = measure_table(conn, table, INSERTS_PER_TABLE)
            lats.sort()
            p50 = percentile(lats, 50) * 1000
            p95 = percentile(lats, 95) * 1000
            results[table] = {"base": base_rows, "p50": p50, "p95": p95}
            print("{:<10s}({} base): p50={:>7.1f}ms  p95={:>7.1f}ms".format(
                table, base_rows, p50, p95
            ))

        p50s = [results[t]["p50"] for t, _ in tables]
        variance = max(p50s) / min(p50s) if min(p50s) > 0 else float("inf")
        print("Cross-table variance: {:.2f}x (max/min p50)".format(variance))

        # Thresholds
        print("--- Thresholds ---")
        passed = True
        for table, _ in tables:
            r = results[table]
            ok = r["p50"] < P50_THRESHOLD_MS
            status = "PASS" if ok else "FAIL"
            if not ok:
                passed = False
            print("{} p50: {:.1f}ms [{}] (< {}ms)".format(
                table, r["p50"], status, P50_THRESHOLD_MS
            ))

        var_status = "PASS" if variance < VARIANCE_THRESHOLD else "WARN"
        print("Variance: {:.2f}x [{}] (< {:.2f}x)".format(
            variance, var_status, VARIANCE_THRESHOLD
        ))

        if passed:
            print("=== P6: PASS ===")
        else:
            print("=== P6: FAIL ===")
            sys.exit(1)

    finally:
        cleanup = connect()
        cleanup.autocommit = True
        with cleanup.cursor() as cc:
            try:
                cc.execute(
                    "SELECT query_id FROM pgr.get_subscriptions() "
                    "WHERE query_id LIKE 'p6_q%'"
                )
                for row in cc.fetchall():
                    cc.execute("SELECT pgr.unsubscribe(%s)", (row[0],))
            except Exception:
                pass
            try:
                cc.execute(
                    "DROP TABLE IF EXISTS p6_orders, p6_products, "
                    "p6_customers CASCADE"
                )
            except Exception:
                pass
        cleanup.close()
        conn.close()


if __name__ == "__main__":
    main()
