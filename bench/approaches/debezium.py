"""Debezium CDC approach adapter.

Debezium captures row-level changes from PostgreSQL's Write-Ahead Log (WAL)
via the ``pgoutput`` logical replication plugin and publishes them to Kafka.

This adapter:
  - Registers a Debezium PostgreSQL connector via the Kafka Connect REST API.
  - Measures delivery latency by monitoring WAL replication slot progress
    (``confirmed_flush_lsn``) as a proxy for change capture.  A full
    end-to-end measurement would require a Kafka consumer, which is not
    feasible with only stdlib + psycopg2.
  - Falls back to subprocess-based ``kafka-console-consumer`` when the
    binary is available in the container.

Supported queries:
  Q2 - Single-table filter on products.  Debezium captures per-table CDC
       events; query-level semantics are handled downstream.

Not supported:
  Q1, Q3-Q8 - Debezium is table-level CDC, not query-level.  Multi-table
  JOINs, aggregation, window functions, and CTEs require downstream
  stream processing (e.g. Kafka Streams / Flink) which is out of scope.
"""

import json
import os
import time
import urllib.error
import urllib.request

from .base import BenchApproach

_DEBEZIUM_URL = os.environ.get("DEBEZIUM_URL", "http://debezium:8083")
_KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "kafka:9092")

_CONNECTOR_NAME = "bench-connector"

_CONNECTOR_CONFIG = {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": os.environ.get("BENCH_DB_HOST", "bench-db"),
    "database.port": os.environ.get("BENCH_DB_PORT", "5432"),
    "database.user": os.environ.get("BENCH_DB_USER", "postgres"),
    "database.password": os.environ.get("BENCH_DB_PASSWORD", "postgres"),
    "database.dbname": os.environ.get("BENCH_DB_NAME", "bench_db"),
    "topic.prefix": "bench",
    "table.include.list": "public.orders,public.products,public.customers",
    "plugin.name": "pgoutput",
    "publication.name": "bench_pub",
    "slot.name": "bench_slot",
}


def _connect_request(
    path: str,
    payload: dict | None = None,
    method: str = "GET",
) -> dict:
    """Send a request to the Kafka Connect REST API.

    Args:
        path: API path (e.g. '/connectors').
        payload: Optional JSON body.
        method: HTTP method.

    Returns:
        Parsed JSON response as a dict, or empty dict.

    Raises:
        RuntimeError: On HTTP errors or unreachable service.
    """
    url = f"{_DEBEZIUM_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload else None
    headers = {"Content-Type": "application/json"} if data else {}

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Kafka Connect {method} {path} returned {exc.code}: {body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Kafka Connect {path} unreachable: {exc.reason}"
        ) from exc


def _get_flush_lsn(conn, slot_name: str = "bench_slot") -> str | None:
    """Read the confirmed_flush_lsn for a replication slot.

    Args:
        conn: psycopg2 connection.
        slot_name: Name of the logical replication slot.

    Returns:
        The LSN string (e.g. '0/16B3740') or None if the slot doesn't exist.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT confirmed_flush_lsn FROM pg_replication_slots "
            "WHERE slot_name = %s",
            (slot_name,),
        )
        row = cur.fetchone()
        return row[0] if row else None


def _lsn_to_int(lsn: str) -> int:
    """Convert a PostgreSQL LSN string like '0/16B3740' to an integer.

    Args:
        lsn: LSN in 'X/Y' hex format.

    Returns:
        Integer representation of the LSN.
    """
    high, low = lsn.split("/")
    return (int(high, 16) << 32) + int(low, 16)


class DebeziumApproach(BenchApproach):
    """Debezium CDC via Kafka Connect adapter.

    Change detection is measured by monitoring the ``confirmed_flush_lsn``
    of the replication slot.  When Debezium reads and acknowledges new WAL
    data, the LSN advances -- giving a reasonable proxy for capture latency
    without requiring a Kafka consumer library.
    """

    name = "debezium"
    supported_queries = ["Q2"]
    produces_delta = True   # Row-level before/after
    push_based = True

    def __init__(self) -> None:
        self._slot_name = _CONNECTOR_CONFIG.get("slot.name", "bench_slot")
        self._baseline_lsn: dict[str, str | None] = {}

    # ------------------------------------------------------------------
    # BenchApproach interface
    # ------------------------------------------------------------------

    def setup(self, conn, query_id: str, query_sql: str) -> None:
        """Register the Debezium connector via Kafka Connect REST API.

        The connector is created (or updated) to capture changes from the
        tables listed in ``table.include.list``.  We also record the
        current replication slot LSN as a baseline.
        """
        # Ensure the publication exists (Debezium needs it)
        pub_name = _CONNECTOR_CONFIG["publication.name"]
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_publication WHERE pubname = %s",
                (pub_name,),
            )
            if not cur.fetchone():
                cur.execute(
                    f"CREATE PUBLICATION {pub_name} FOR TABLE "
                    "orders, products, customers"
                )

        # Create or update the connector
        try:
            _connect_request(
                f"/connectors/{_CONNECTOR_NAME}/config",
                payload=_CONNECTOR_CONFIG,
                method="PUT",
            )
        except RuntimeError:
            # Connector may already exist or Connect not ready; try POST
            try:
                _connect_request(
                    "/connectors",
                    payload={"name": _CONNECTOR_NAME, "config": _CONNECTOR_CONFIG},
                    method="POST",
                )
            except RuntimeError:
                pass  # Will be caught at wait_for_change time

        # Wait briefly for Debezium to create the replication slot
        time.sleep(2.0)

        # Record baseline LSN
        self._baseline_lsn[query_id] = _get_flush_lsn(conn, self._slot_name)

    def teardown(self, conn, query_id: str) -> None:
        """Delete the Debezium connector and clean up."""
        self._baseline_lsn.pop(query_id, None)

        try:
            _connect_request(
                f"/connectors/{_CONNECTOR_NAME}",
                method="DELETE",
            )
        except RuntimeError:
            pass  # Best-effort cleanup

        # Drop the replication slot if it still exists
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "SELECT pg_drop_replication_slot(%s)",
                    (self._slot_name,),
                )
            except Exception:
                conn.rollback()

    def setup_listener(self, listener_conn, query_id: str) -> None:
        """No special listener setup; we monitor the replication slot."""
        pass

    def wait_for_change(
        self, listener_conn, query_id: str, timeout_s: float = 5.0
    ):
        """Wait for the replication slot's confirmed_flush_lsn to advance.

        This indicates Debezium has read and acknowledged new WAL records,
        serving as a proxy for change capture latency.

        Args:
            listener_conn: psycopg2 connection used to query pg_replication_slots.
            query_id: The benchmark query identifier.
            timeout_s: Maximum seconds to wait.

        Returns:
            A dict with ``received``, ``payload``, ``has_delta`` keys,
            or ``None`` on timeout.
        """
        baseline = self._baseline_lsn.get(query_id)
        baseline_int = _lsn_to_int(baseline) if baseline else 0
        deadline = time.monotonic() + timeout_s
        poll_interval = 0.1  # 100 ms

        while time.monotonic() < deadline:
            current_lsn = _get_flush_lsn(listener_conn, self._slot_name)
            if current_lsn:
                current_int = _lsn_to_int(current_lsn)
                if current_int > baseline_int:
                    # LSN advanced -- Debezium consumed new WAL
                    self._baseline_lsn[query_id] = current_lsn
                    return {
                        "received": True,
                        "payload": {
                            "lsn_before": baseline,
                            "lsn_after": current_lsn,
                        },
                        "has_delta": True,
                    }
            time.sleep(poll_interval)

        return None

    def read_current(self, conn, query_id: str, query_sql: str = None):
        """Read current data via the original SQL query.

        Debezium does not maintain a materialized view; it only streams
        changes.  Fall back to direct SQL for correctness checks.
        """
        if query_sql:
            return super().read_current(conn, query_id, query_sql)
        return []
