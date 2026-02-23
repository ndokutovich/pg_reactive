"""pg_ivm approach adapter."""

import time
from .base import BenchApproach


class IvmApproach(BenchApproach):
    name = "pg_ivm"
    # pg_ivm does not support HAVING, window functions, ORDER BY, LIMIT
    supported_queries = ["Q1", "Q2", "Q3", "Q4"]
    produces_delta = False  # Updates IMMV in-place, no event stream
    push_based = False      # Synchronous (view updated within same transaction)

    def setup(self, conn, query_id, query_sql):
        view_name = f"immv_{query_id.lower()}"
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_ivm")
            # Drop if exists (from previous run)
            cur.execute(f"DROP TABLE IF EXISTS {view_name} CASCADE")
            try:
                cur.execute(
                    "SELECT create_immv(%s, %s)", (view_name, query_sql)
                )
                self._views = getattr(self, "_views", {})
                self._views[query_id] = view_name
            except Exception as e:
                conn.rollback()
                raise

    def teardown(self, conn, query_id):
        views = getattr(self, "_views", {})
        view_name = views.pop(query_id, f"immv_{query_id.lower()}")
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {view_name} CASCADE")

    def wait_for_change(self, listener_conn, query_id, timeout_s=5.0):
        """
        pg_ivm is synchronous — the IMMV is updated before DML COMMIT returns.
        So "delivery latency" is the DML duration itself (measured by the scenario).
        This method just reads the current IMMV to confirm the change is there.
        """
        views = getattr(self, "_views", {})
        view_name = views.get(query_id, f"immv_{query_id.lower()}")
        with listener_conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {view_name}")
            count = cur.fetchone()[0]
        return {"received": True, "payload": {"row_count": count}, "has_delta": False}

    def read_current(self, conn, query_id, query_sql=None):
        views = getattr(self, "_views", {})
        view_name = views.get(query_id, f"immv_{query_id.lower()}")
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {view_name}")
            return cur.fetchall()

    def supports_query(self, query_id):
        return query_id in self.supported_queries
