"""
Base adapter interface for benchmark approaches.

Each approach implements this interface so the harness can treat them uniformly.
"""

import re
import os

# Query definitions — loaded from queries.sql
QUERIES = {}

def load_queries(path=None):
    """Parse queries.sql and populate QUERIES dict."""
    global QUERIES
    if QUERIES:
        return QUERIES

    if path is None:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "queries.sql")

    with open(path) as f:
        content = f.read()

    # Split by "-- ID: Qn" markers
    parts = re.split(r"--\s*ID:\s*(Q\d+)\s*\n", content)
    # parts = [preamble, 'Q1', sql1, 'Q2', sql2, ...]
    for i in range(1, len(parts), 2):
        qid = parts[i]
        raw = parts[i + 1]
        # Take only up to the first semicolon (strip trailing comments for next query)
        semi_pos = raw.find(";")
        if semi_pos >= 0:
            raw = raw[:semi_pos]
        QUERIES[qid] = raw.strip()

    return QUERIES


class BenchApproach:
    """Abstract base for benchmark approach adapters."""

    name = "base"
    supported_queries = []  # e.g. ['Q1', 'Q2', ...]
    produces_delta = False  # True if it emits {inserted, deleted}
    push_based = False      # True if it pushes changes asynchronously

    def setup(self, conn, query_id, query_sql):
        """Register a query for tracking. Called once before benchmark."""
        raise NotImplementedError

    def teardown(self, conn, query_id):
        """Unregister a query. Called after benchmark."""
        raise NotImplementedError

    def setup_listener(self, listener_conn, query_id):
        """Prepare a connection to receive change notifications."""
        pass

    def wait_for_change(self, listener_conn, query_id, timeout_s=5.0):
        """
        Wait for a change notification/event.
        Returns a dict with at least {'received': True/False, 'payload': ...}
        or None on timeout.
        """
        return None

    def supports_query(self, query_id):
        """Whether this approach supports the given query."""
        return query_id in self.supported_queries

    def read_current(self, conn, query_id, query_sql):
        """Read the current result (for polling or IMMV approaches)."""
        with conn.cursor() as cur:
            cur.execute(query_sql)
            return cur.fetchall()
