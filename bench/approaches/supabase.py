"""Supabase Realtime approach adapter.

Supabase Realtime is an Elixir/Phoenix application that reads PostgreSQL
WAL changes and pushes them to clients via WebSocket (Phoenix Channels).
Version 2 uses logical replication with publications.

This adapter:
  - Verifies the Supabase Realtime service is reachable.
  - Configures a logical replication publication for the target tables.
  - Measures delivery latency by monitoring WAL replication slot progress
    (similar to the Debezium adapter), since implementing the Phoenix
    Channels protocol with stdlib-only is impractical.

Supported queries:
  Q2 - Single-table filter on products.  Supabase Realtime is table-level;
       client-side filtering maps to Realtime's ``filter`` parameter.

Not supported:
  Q1, Q3-Q8 - Supabase Realtime is table-level CDC.  Multi-table JOINs,
  aggregation, window functions, and CTEs require application-level logic.
"""

import json
import os
import time
import urllib.error
import urllib.request

from .base import BenchApproach

_SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://supabase-realtime:4000")
_REALTIME_SLOT = os.environ.get("SUPABASE_SLOT", "supabase_realtime_slot")
_REALTIME_PUB = os.environ.get("SUPABASE_PUB", "supabase_realtime")


def _health_check() -> bool:
    """Check if the Supabase Realtime service is reachable.

    Returns:
        True if the service responds to an HTTP request, False otherwise.
    """
    url = f"{_SUPABASE_URL}/api/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        # Try root path as fallback (some versions expose health there)
        try:
            fallback_url = f"{_SUPABASE_URL}/"
            req2 = urllib.request.Request(fallback_url, method="GET")
            with urllib.request.urlopen(req2, timeout=5) as resp:
                return resp.status < 500
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            return False


def _get_flush_lsn(conn, slot_name: str) -> str | None:
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


class SupabaseApproach(BenchApproach):
    """Supabase Realtime adapter.

    Supabase Realtime v2 uses logical replication (pgoutput) to stream
    row-level changes to connected clients over WebSocket.  Since
    implementing the Phoenix Channels protocol in pure Python stdlib is
    impractical, delivery latency is measured by monitoring the
    replication slot's ``confirmed_flush_lsn`` as a WAL-capture proxy.

    This is documented in results output so benchmark consumers know that
    the measured latency reflects WAL capture, not full end-to-end
    WebSocket delivery to a client.
    """

    name = "supabase"
    supported_queries = ["Q2"]
    produces_delta = True   # Row-level insert/update/delete events
    push_based = True

    def __init__(self) -> None:
        self._slot_name = _REALTIME_SLOT
        self._pub_name = _REALTIME_PUB
        self._baseline_lsn: dict[str, str | None] = {}
        self._service_reachable: bool | None = None

    # ------------------------------------------------------------------
    # BenchApproach interface
    # ------------------------------------------------------------------

    def setup(self, conn, query_id: str, query_sql: str) -> None:
        """Verify Supabase Realtime is running and configure replication.

        Creates a publication for the target tables if one doesn't exist.
        Supabase Realtime auto-discovers publications and begins streaming
        changes from them.
        """
        # Check service health
        self._service_reachable = _health_check()
        if not self._service_reachable:
            raise RuntimeError(
                f"Supabase Realtime not reachable at {_SUPABASE_URL}"
            )

        # Ensure publication exists (Supabase Realtime reads from it)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_publication WHERE pubname = %s",
                (self._pub_name,),
            )
            if not cur.fetchone():
                cur.execute(
                    f"CREATE PUBLICATION {self._pub_name} FOR TABLE "
                    "orders, products, customers"
                )

        # Record baseline LSN (slot is created by Supabase Realtime)
        # Wait briefly for the service to create its slot
        time.sleep(1.0)
        self._baseline_lsn[query_id] = _get_flush_lsn(conn, self._slot_name)

        # If the slot doesn't exist yet, the service may create it lazily
        # when the first client subscribes.  Record None; wait_for_change
        # will handle it gracefully.

    def teardown(self, conn, query_id: str) -> None:
        """Clean up cached state.

        We do NOT drop the publication or replication slot because
        Supabase Realtime owns them and may be serving other clients.
        """
        self._baseline_lsn.pop(query_id, None)

    def setup_listener(self, listener_conn, query_id: str) -> None:
        """No special listener setup; we monitor the replication slot."""
        pass

    def wait_for_change(
        self, listener_conn, query_id: str, timeout_s: float = 5.0
    ):
        """Wait for the replication slot's confirmed_flush_lsn to advance.

        This indicates Supabase Realtime has read new WAL records,
        serving as a proxy for change capture latency.

        Note: This measures WAL capture latency, not end-to-end WebSocket
        delivery to a client.  This is documented in benchmark output.

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
                    self._baseline_lsn[query_id] = current_lsn
                    return {
                        "received": True,
                        "payload": {
                            "lsn_before": baseline,
                            "lsn_after": current_lsn,
                            "note": "WAL capture proxy, not end-to-end WS delivery",
                        },
                        "has_delta": True,
                    }
            else:
                # Slot doesn't exist (yet); cannot measure
                if time.monotonic() > deadline - 1.0:
                    return {
                        "received": False,
                        "payload": {
                            "error": f"Replication slot '{self._slot_name}' not found"
                        },
                        "has_delta": False,
                    }

            time.sleep(poll_interval)

        return None

    def read_current(self, conn, query_id: str, query_sql: str = None):
        """Read current data via the original SQL query.

        Supabase Realtime does not maintain a materialized view; it only
        streams changes.  Fall back to direct SQL for correctness checks.
        """
        if query_sql:
            return super().read_current(conn, query_id, query_sql)
        return []
