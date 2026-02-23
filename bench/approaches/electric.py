"""ElectricSQL approach adapter.

ElectricSQL syncs PostgreSQL data to clients via HTTP using "Shapes" --
declarative subscriptions scoped to a single table with optional WHERE
filters.  The protocol uses Server-Sent Events (SSE) for real-time
streaming and supports long-polling for change detection.

This adapter:
  - Creates a Shape subscription via Electric's HTTP API.
  - Measures delivery latency using live long-polling on the shape endpoint,
    which blocks until new data is available or the timeout expires.
  - Uses only stdlib (urllib.request) -- no external dependencies needed
    because Electric's protocol is plain HTTP + SSE.

Supported queries:
  Q2 - Single-table filter on products WHERE category = 'electronics'.
       This maps directly to an Electric Shape with a WHERE clause.

Not supported:
  Q1, Q3-Q8 - ElectricSQL Shapes are single-table only.  Multi-table
  JOINs, aggregation, window functions, and CTEs are not supported.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from .base import BenchApproach

_ELECTRIC_URL = os.environ.get("ELECTRIC_URL", "http://electric:3000")

# Mapping of query_id to Electric Shape parameters
_SHAPE_MAP = {
    "Q2": {
        "table": "products",
        "columns": "id,name,price",
        "where": "category = 'electronics'",
    },
}


def _electric_request(
    path: str,
    params: dict | None = None,
    timeout: float = 10.0,
) -> tuple[bytes, dict[str, str]]:
    """Send a GET request to the Electric HTTP API.

    Args:
        path: API path (e.g. '/v1/shape').
        params: Query string parameters.
        timeout: Request timeout in seconds.

    Returns:
        Tuple of (response body bytes, response headers dict).

    Raises:
        RuntimeError: On HTTP errors or unreachable service.
    """
    url = f"{_ELECTRIC_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            headers = {k.lower(): v for k, v in resp.getheaders()}
            return body, headers
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Electric GET {path} returned {exc.code}: {body}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Electric {path} unreachable: {exc.reason}"
        ) from exc


def _parse_sse_body(body: bytes) -> list[dict]:
    """Parse a Server-Sent Events response body into a list of data dicts.

    Electric returns SSE-formatted responses where each event is a
    ``data:`` line containing JSON.  Control messages use different
    event types (e.g. ``event: up-to-date``).

    Args:
        body: Raw response bytes.

    Returns:
        List of parsed JSON objects from data lines.
    """
    results = []
    text = body.decode("utf-8", errors="replace")

    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            json_str = line[5:].strip()
            if json_str:
                try:
                    results.append(json.loads(json_str))
                except json.JSONDecodeError:
                    pass

    # Electric may also return plain JSON lines (non-SSE mode)
    if not results:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("{") or line.startswith("["):
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, list):
                        results.extend(parsed)
                    else:
                        results.append(parsed)
                except json.JSONDecodeError:
                    pass

    return results


class ElectricApproach(BenchApproach):
    """ElectricSQL Shape-based sync adapter.

    Delivery latency is measured using Electric's long-polling mode:
    a GET request with ``live=true`` blocks until new data is available,
    giving accurate end-to-end latency without needing WebSocket support.

    This is the most faithful Tier 2 measurement because Electric's
    primary client protocol IS HTTP long-polling/SSE.
    """

    name = "electric"
    supported_queries = ["Q2"]
    produces_delta = True   # Shape log contains insert/update/delete ops
    push_based = True

    def __init__(self) -> None:
        self._shape_handles: dict[str, str] = {}
        self._offsets: dict[str, str] = {}

    # ------------------------------------------------------------------
    # BenchApproach interface
    # ------------------------------------------------------------------

    def setup(self, conn, query_id: str, query_sql: str) -> None:
        """Create a Shape subscription and capture the initial snapshot.

        Sends an initial request with ``offset=-1`` to establish the shape
        and receive the full initial dataset.  Stores the shape handle and
        latest offset for subsequent live-polling.
        """
        shape_def = _SHAPE_MAP.get(query_id)
        if not shape_def:
            raise RuntimeError(
                f"Electric adapter has no shape mapping for {query_id}"
            )

        params = {"table": shape_def["table"], "offset": "-1"}
        if "columns" in shape_def:
            params["columns"] = shape_def["columns"]
        if "where" in shape_def:
            params["where"] = shape_def["where"]

        try:
            body, headers = _electric_request("/v1/shape", params=params)
        except RuntimeError as exc:
            raise RuntimeError(
                f"Electric shape creation failed for {query_id}: {exc}"
            ) from exc

        # Extract shape handle and offset from response headers
        # Electric uses: electric-handle, electric-offset
        shape_handle = headers.get("electric-handle", "")
        offset = headers.get("electric-offset", "-1")

        # Some versions use x-electric-* prefixed headers
        if not shape_handle:
            shape_handle = headers.get("x-electric-shape-id", "")
        if offset == "-1":
            offset = headers.get("x-electric-chunk-last-offset", "-1")

        # Parse SSE body for embedded offset in control messages
        events = _parse_sse_body(body)
        for event in events:
            if "offset" in event:
                offset = str(event["offset"])
            if "headers" in event and isinstance(event["headers"], dict):
                h = event["headers"]
                if "electric-handle" in h:
                    shape_handle = h["electric-handle"]
                if "electric-offset" in h:
                    offset = h["electric-offset"]

        self._shape_handles[query_id] = shape_handle
        self._offsets[query_id] = offset

    def teardown(self, conn, query_id: str) -> None:
        """Delete the shape subscription if the API supports it.

        Electric shapes are ephemeral and server-managed; explicit
        deletion may not be required but we attempt it for cleanliness.
        """
        shape_handle = self._shape_handles.pop(query_id, None)
        self._offsets.pop(query_id, None)

        if shape_handle:
            try:
                params = {"handle": shape_handle}
                url = f"{_ELECTRIC_URL}/v1/shape"
                url += "?" + urllib.parse.urlencode(params)
                req = urllib.request.Request(url, method="DELETE")
                urllib.request.urlopen(req, timeout=5)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError):
                pass  # Best-effort cleanup

    def setup_listener(self, listener_conn, query_id: str) -> None:
        """No special listener setup; we use HTTP long-polling."""
        pass

    def wait_for_change(
        self, listener_conn, query_id: str, timeout_s: float = 5.0
    ):
        """Long-poll the Electric shape endpoint for changes.

        Sends a GET request with ``live=true`` and the last known offset.
        Electric holds the connection open until new data is available or
        the server-side timeout expires.

        Args:
            listener_conn: Unused (polling is via HTTP, not PG connection).
            query_id: The benchmark query identifier.
            timeout_s: Maximum seconds to wait.

        Returns:
            A dict with ``received``, ``payload``, ``has_delta`` keys,
            or ``None`` on timeout.
        """
        shape_def = _SHAPE_MAP.get(query_id)
        if not shape_def:
            return None

        shape_handle = self._shape_handles.get(query_id)
        offset = self._offsets.get(query_id, "-1")

        params = {
            "table": shape_def["table"],
            "live": "true",
            "offset": offset,
        }
        if shape_handle:
            params["handle"] = shape_handle
        if "columns" in shape_def:
            params["columns"] = shape_def["columns"]
        if "where" in shape_def:
            params["where"] = shape_def["where"]

        deadline = time.monotonic() + timeout_s

        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break

            try:
                body, headers = _electric_request(
                    "/v1/shape",
                    params=params,
                    timeout=min(remaining + 1.0, timeout_s + 1.0),
                )
            except RuntimeError:
                # Electric may 204/timeout on no-change; retry
                time.sleep(0.2)
                continue

            events = _parse_sse_body(body)

            # Update offset and handle from response
            new_offset = headers.get(
                "electric-offset",
                headers.get("x-electric-chunk-last-offset", offset),
            )
            new_handle = headers.get(
                "electric-handle",
                headers.get("x-electric-shape-id", shape_handle),
            )

            # Also check inside SSE events for offset updates
            for event in events:
                if "offset" in event:
                    new_offset = str(event["offset"])
                if "headers" in event and isinstance(event["headers"], dict):
                    h = event["headers"]
                    if "electric-offset" in h:
                        new_offset = h["electric-offset"]
                    if "electric-handle" in h:
                        new_handle = h["electric-handle"]

            self._offsets[query_id] = new_offset
            if new_handle:
                self._shape_handles[query_id] = new_handle

            # Check if we got actual data events (not just control messages)
            data_events = [
                e for e in events
                if e.get("value") or e.get("key")
            ]

            if data_events:
                return {
                    "received": True,
                    "payload": {
                        "events": data_events,
                        "event_count": len(data_events),
                    },
                    "has_delta": True,
                }

            # Check for up-to-date control message with no data
            # (means our long-poll timed out server-side with no changes)
            up_to_date = any(
                e.get("headers", {}).get("control") == "up-to-date"
                for e in events
                if isinstance(e.get("headers"), dict)
            )
            if up_to_date and not data_events:
                # No new data; update params and retry
                params["offset"] = new_offset
                if new_handle:
                    params["handle"] = new_handle
                continue

            # Non-empty response but no recognizable data events
            # Could be initial snapshot replay; retry with new offset
            if events:
                params["offset"] = new_offset
                if new_handle:
                    params["handle"] = new_handle
                continue

            time.sleep(0.2)

        return None

    def read_current(self, conn, query_id: str, query_sql: str = None):
        """Read the current shape snapshot from Electric.

        Fetches the full shape from Electric's HTTP API to get the
        current state as Electric sees it.
        """
        shape_def = _SHAPE_MAP.get(query_id)
        if not shape_def:
            if query_sql:
                return super().read_current(conn, query_id, query_sql)
            return []

        params = {"table": shape_def["table"], "offset": "-1"}
        if "columns" in shape_def:
            params["columns"] = shape_def["columns"]
        if "where" in shape_def:
            params["where"] = shape_def["where"]

        try:
            body, _ = _electric_request("/v1/shape", params=params)
            events = _parse_sse_body(body)
            # Extract row values from insert events
            rows = []
            for event in events:
                value = event.get("value")
                if value and isinstance(value, dict):
                    rows.append(tuple(value.values()))
            return rows
        except RuntimeError:
            # Fall back to direct SQL
            if query_sql:
                return super().read_current(conn, query_id, query_sql)
            return []
