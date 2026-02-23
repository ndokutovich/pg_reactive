"""Polling approach adapter."""

import time
import hashlib
import json
from .base import BenchApproach


class PollApproach(BenchApproach):
    name = "polling"
    supported_queries = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"]
    produces_delta = False  # Client must diff
    push_based = False

    def __init__(self, poll_interval_ms=100):
        self.poll_interval_ms = poll_interval_ms
        self._queries = {}
        self._hashes = {}

    def setup(self, conn, query_id, query_sql):
        self._queries[query_id] = query_sql
        # Store initial hash
        self._hashes[query_id] = self._query_hash(conn, query_sql)

    def teardown(self, conn, query_id):
        self._queries.pop(query_id, None)
        self._hashes.pop(query_id, None)

    def wait_for_change(self, listener_conn, query_id, timeout_s=5.0):
        """Poll until the query result hash changes."""
        query_sql = self._queries.get(query_id)
        if not query_sql:
            return None

        old_hash = self._hashes.get(query_id)
        deadline = time.monotonic() + timeout_s
        interval = self.poll_interval_ms / 1000.0

        while time.monotonic() < deadline:
            new_hash = self._query_hash(listener_conn, query_sql)
            if new_hash != old_hash:
                self._hashes[query_id] = new_hash
                return {"received": True, "payload": {"hash_changed": True}, "has_delta": False}
            time.sleep(interval)

        return None

    def _query_hash(self, conn, query_sql):
        """Execute query and return MD5 of the result."""
        with conn.cursor() as cur:
            cur.execute(query_sql)
            rows = cur.fetchall()
            return hashlib.md5(str(rows).encode()).hexdigest()
