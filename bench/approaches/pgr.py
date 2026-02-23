"""pg_reactive approach adapter."""

import json
import select
from .base import BenchApproach


class PgrApproach(BenchApproach):
    name = "pg_reactive"
    supported_queries = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]
    produces_delta = True
    push_based = True

    def setup(self, conn, query_id, query_sql):
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_reactive")
            cur.execute(
                "SELECT pgr.subscribe(%s, %s)", (query_id, query_sql)
            )

    def teardown(self, conn, query_id):
        with conn.cursor() as cur:
            cur.execute("SELECT pgr.unsubscribe(%s)", (query_id,))

    def setup_listener(self, listener_conn, query_id):
        listener_conn.autocommit = True
        with listener_conn.cursor() as cur:
            cur.execute("LISTEN pgr")

    def wait_for_change(self, listener_conn, query_id, timeout_s=5.0):
        """Wait for a NOTIFY on the pgr channel matching this query_id."""
        deadline = __import__("time").monotonic() + timeout_s

        while True:
            remaining = deadline - __import__("time").monotonic()
            if remaining <= 0:
                return None

            # Check buffer first
            listener_conn.poll()
            while listener_conn.notifies:
                n = listener_conn.notifies.pop(0)
                if n.channel != "pgr":
                    continue
                try:
                    payload = json.loads(n.payload)
                except (json.JSONDecodeError, TypeError):
                    continue
                if payload.get("query_id") == query_id:
                    return {
                        "received": True,
                        "payload": payload,
                        "has_delta": "inserted" in payload or "deleted" in payload,
                    }

            # Wait for data on the connection
            if select.select([listener_conn], [], [], min(remaining, 0.5)) == ([], [], []):
                continue
