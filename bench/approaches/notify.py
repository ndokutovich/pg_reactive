"""Manual LISTEN/NOTIFY baseline adapter.

Creates a simple trigger that sends pg_notify on every DML.
No delta computation — just measures raw notification latency.
"""

import json
import select
from .base import BenchApproach


class NotifyApproach(BenchApproach):
    name = "listen_notify"
    supported_queries = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]
    produces_delta = False  # Just a signal, no delta
    push_based = True

    def setup(self, conn, query_id, query_sql):
        """Install a minimal AFTER INSERT trigger that sends NOTIFY."""
        channel = f"bench_{query_id.lower()}"
        with conn.cursor() as cur:
            # Create trigger function
            cur.execute(f"""
                CREATE OR REPLACE FUNCTION bench_notify_{query_id.lower()}()
                RETURNS trigger AS $$
                BEGIN
                    PERFORM pg_notify('{channel}',
                        json_build_object('query_id', '{query_id}', 'op', TG_OP)::text);
                    RETURN NULL;
                END;
                $$ LANGUAGE plpgsql
            """)
            # Install on orders table (the main DML target in benchmarks)
            cur.execute(f"""
                DROP TRIGGER IF EXISTS bench_trig_{query_id.lower()} ON orders
            """)
            cur.execute(f"""
                CREATE TRIGGER bench_trig_{query_id.lower()}
                AFTER INSERT OR UPDATE OR DELETE ON orders
                FOR EACH STATEMENT
                EXECUTE FUNCTION bench_notify_{query_id.lower()}()
            """)
        self._channels = getattr(self, "_channels", {})
        self._channels[query_id] = channel

    def teardown(self, conn, query_id):
        with conn.cursor() as cur:
            cur.execute(f"DROP TRIGGER IF EXISTS bench_trig_{query_id.lower()} ON orders")
            cur.execute(f"DROP FUNCTION IF EXISTS bench_notify_{query_id.lower()}")
        channels = getattr(self, "_channels", {})
        channels.pop(query_id, None)

    def setup_listener(self, listener_conn, query_id):
        listener_conn.autocommit = True
        channel = getattr(self, "_channels", {}).get(query_id, f"bench_{query_id.lower()}")
        with listener_conn.cursor() as cur:
            cur.execute(f"LISTEN {channel}")

    def wait_for_change(self, listener_conn, query_id, timeout_s=5.0):
        channel = getattr(self, "_channels", {}).get(query_id, f"bench_{query_id.lower()}")
        deadline = __import__("time").monotonic() + timeout_s

        while True:
            remaining = deadline - __import__("time").monotonic()
            if remaining <= 0:
                return None

            listener_conn.poll()
            while listener_conn.notifies:
                n = listener_conn.notifies.pop(0)
                if n.channel == channel:
                    try:
                        payload = json.loads(n.payload)
                    except (json.JSONDecodeError, TypeError):
                        payload = {"raw": n.payload}
                    return {"received": True, "payload": payload, "has_delta": False}

            if select.select([listener_conn], [], [], min(remaining, 0.5)) == ([], [], []):
                continue
