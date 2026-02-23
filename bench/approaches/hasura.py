"""Hasura GraphQL Engine approach adapter.

Hasura tracks PostgreSQL tables and exposes them via a GraphQL API.
Subscriptions are internally powered by polling the database (default 1s).

This adapter:
  - Uses the Hasura Metadata API to track tables and create relationships.
  - Maps benchmark queries to Hasura-compatible GraphQL.
  - Measures delivery latency by polling the /v1/graphql POST endpoint
    until the result set changes, which faithfully reflects Hasura's
    internal polling behavior.

Supported queries:
  Q2 - Single-table filter (products WHERE category = 'electronics')
  Q8 - ORDER BY + LIMIT on orders with JOINs via relationships

Not supported:
  Q4 - Aggregation (GROUP BY + SUM) requires custom SQL / computed fields
  Q5 - HAVING clause not expressible in standard Hasura GraphQL
  Q6 - Window functions not expressible
  Q7 - CTE not expressible
"""

import hashlib
import json
import os
import time
import urllib.error
import urllib.request

from .base import BenchApproach

_HASURA_URL = os.environ.get("HASURA_URL", "http://hasura:8080")
_HASURA_ADMIN_SECRET = os.environ.get("HASURA_ADMIN_SECRET", "")

# Hasura-compatible GraphQL for each supported query
_GRAPHQL_MAP = {
    "Q2": {
        "query": (
            "query Q2 {"
            "  products(where: {category: {_eq: \"electronics\"}}) {"
            "    id name price"
            "  }"
            "}"
        ),
        "tables": ["products"],
    },
    "Q8": {
        "query": (
            "query Q8 {"
            "  orders(order_by: {created_at: desc}, limit: 50) {"
            "    id total created_at"
            "    customer { name }"
            "    product { name }"
            "  }"
            "}"
        ),
        "tables": ["orders", "customers", "products"],
    },
}


def _hasura_request(path: str, payload: dict, method: str = "POST") -> dict:
    """Send a request to the Hasura API and return the JSON response.

    Args:
        path: API path (e.g. '/v1/metadata', '/v1/graphql').
        payload: JSON body to send.
        method: HTTP method (default POST).

    Returns:
        Parsed JSON response as a dict.

    Raises:
        RuntimeError: On HTTP errors or unreachable service.
    """
    url = f"{_HASURA_URL}{path}"
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if _HASURA_ADMIN_SECRET:
        headers["X-Hasura-Admin-Secret"] = _HASURA_ADMIN_SECRET

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Hasura API {path} returned {exc.code}: {body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Hasura API {path} unreachable: {exc.reason}"
        ) from exc


def _metadata(payload: dict) -> dict:
    """Shortcut for Hasura Metadata API v1."""
    return _hasura_request("/v1/metadata", payload)


def _graphql(query: str) -> dict:
    """Execute a GraphQL query via Hasura's POST endpoint."""
    return _hasura_request("/v1/graphql", {"query": query})


def _track_table_safe(table: str, source: str = "default") -> None:
    """Track a table in Hasura, ignoring 'already tracked' errors."""
    try:
        _metadata({
            "type": "pg_track_table",
            "args": {
                "source": source,
                "table": {"schema": "public", "name": table},
            },
        })
    except RuntimeError as exc:
        # Hasura returns 400 if already tracked — that is fine
        if "already tracked" not in str(exc).lower():
            raise


def _create_relationship_safe(
    table: str,
    rel_name: str,
    rel_type: str,
    using: dict,
    source: str = "default",
) -> None:
    """Create a relationship in Hasura, ignoring 'already exists' errors.

    Args:
        table: Source table name.
        rel_name: Relationship name exposed in GraphQL.
        rel_type: 'pg_create_object_relationship' or
                  'pg_create_array_relationship'.
        using: Hasura ``using`` clause dict.
        source: Hasura source name.
    """
    try:
        _metadata({
            "type": rel_type,
            "args": {
                "source": source,
                "table": {"schema": "public", "name": table},
                "name": rel_name,
                "using": using,
            },
        })
    except RuntimeError as exc:
        if "already exists" not in str(exc).lower():
            raise


class HasuraApproach(BenchApproach):
    """Hasura GraphQL Engine adapter.

    Delivery latency is measured by polling Hasura's /v1/graphql endpoint
    until the query result changes.  This mirrors Hasura's actual internal
    behavior where subscriptions are driven by a configurable polling
    interval (default 1 second).
    """

    name = "hasura"
    supported_queries = ["Q2", "Q8"]
    produces_delta = False  # Hasura sends full snapshots
    push_based = True

    def __init__(self) -> None:
        self._result_hashes: dict[str, str] = {}
        self._gql_queries: dict[str, str] = {}

    # ------------------------------------------------------------------
    # BenchApproach interface
    # ------------------------------------------------------------------

    def setup(self, conn, query_id: str, query_sql: str) -> None:
        """Track tables, create relationships, and capture initial hash."""
        gql_info = _GRAPHQL_MAP.get(query_id)
        if not gql_info:
            raise RuntimeError(
                f"Hasura adapter has no GraphQL mapping for {query_id}"
            )

        # Track all required tables
        for table in gql_info["tables"]:
            _track_table_safe(table)

        # Create FK relationships needed by Q8
        if query_id == "Q8":
            _create_relationship_safe(
                "orders",
                "customer",
                "pg_create_object_relationship",
                {"foreign_key_constraint_on": "customer_id"},
            )
            _create_relationship_safe(
                "orders",
                "product",
                "pg_create_object_relationship",
                {"foreign_key_constraint_on": "product_id"},
            )

        gql_query = gql_info["query"]
        self._gql_queries[query_id] = gql_query

        # Store initial result hash
        self._result_hashes[query_id] = self._fetch_hash(gql_query)

    def teardown(self, conn, query_id: str) -> None:
        """Clean up cached state.  We intentionally leave tables tracked
        in Hasura because untracking may disrupt other concurrent runs."""
        self._result_hashes.pop(query_id, None)
        self._gql_queries.pop(query_id, None)

    def setup_listener(self, listener_conn, query_id: str) -> None:
        """No special listener setup needed; we poll via HTTP."""
        pass

    def wait_for_change(
        self, listener_conn, query_id: str, timeout_s: float = 5.0
    ):
        """Poll Hasura's GraphQL endpoint until the result hash changes.

        Args:
            listener_conn: Unused (polling is via HTTP, not PG connection).
            query_id: The benchmark query identifier.
            timeout_s: Maximum seconds to wait.

        Returns:
            A dict with ``received``, ``payload``, ``has_delta`` keys,
            or ``None`` on timeout.
        """
        gql_query = self._gql_queries.get(query_id)
        if not gql_query:
            return None

        old_hash = self._result_hashes.get(query_id)
        deadline = time.monotonic() + timeout_s
        poll_interval = 0.2  # 200 ms

        while time.monotonic() < deadline:
            try:
                new_hash = self._fetch_hash(gql_query)
            except RuntimeError:
                # Hasura temporarily unavailable; retry
                time.sleep(poll_interval)
                continue

            if new_hash != old_hash:
                self._result_hashes[query_id] = new_hash
                return {
                    "received": True,
                    "payload": {"hash_changed": True},
                    "has_delta": False,
                }
            time.sleep(poll_interval)

        return None

    def read_current(self, conn, query_id: str, query_sql: str = None):
        """Read current result from Hasura (not from PG directly)."""
        gql_query = self._gql_queries.get(query_id)
        if not gql_query:
            return super().read_current(conn, query_id, query_sql)

        result = _graphql(gql_query)
        return result.get("data", {})

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fetch_hash(gql_query: str) -> str:
        """Execute a GraphQL query and return an MD5 hash of the response."""
        result = _graphql(gql_query)
        serialized = json.dumps(result, sort_keys=True)
        return hashlib.md5(serialized.encode("utf-8")).hexdigest()
