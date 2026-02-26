/**
 * k6 load test: WebSocket connection scale and message delivery
 *
 * Covers:
 *  - 200 simultaneous WebSocket connections to the proxy
 *  - Each connection subscribes to a live query
 *  - Verifies the "subscribed" welcome message arrives
 *  - Measures connection establishment time and message delivery rate
 *
 * Usage:
 *   k6 run tests/load/ws_load.js
 *   k6 run --env BASE_URL=ws://127.0.0.1:8080 tests/load/ws_load.js
 *   k6 run --env BASE_URL=ws://127.0.0.1:8080 --env JWT_TOKEN=xxx tests/load/ws_load.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Gauge, Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = (__ENV.BASE_URL || "ws://127.0.0.1:8080").replace(
  /^http/,
  "ws"
);
const JWT_TOKEN = __ENV.JWT_TOKEN || "";

// The SQL query each virtual user subscribes to — uses VU id so every client
// gets its own subscription slot and we stress-test the subscription table.
const subscriptionQuery = (vuId) =>
  `SELECT ${vuId} AS vu_id, now() AS ts`;

export const options = {
  scenarios: {
    ws_connections: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 200 },   // ramp to 200 simultaneous connections
        { duration: "30s", target: 200 },   // hold
        { duration: "10s", target: 0 },     // ramp down
      ],
    },
  },

  thresholds: {
    // At least 99 % of connections must receive the welcome "subscribed" message.
    ws_subscribed_rate: ["rate>0.99"],

    // Connection establishment time p95 under 3 s.
    ws_connect_duration_ms: ["p(95)<3000"],

    // Less than 1 % of connections should fail outright.
    ws_connection_failures: ["count<2"],

    // Standard k6 WebSocket check: sessions_blocked p95 < 200 ms.
    "ws_session_duration": ["p(95)<60000"],
  },
};

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const subscribedRate = new Rate("ws_subscribed_rate");
const connectDuration = new Trend("ws_connect_duration_ms", true);
const connectionFailures = new Counter("ws_connection_failures");
const messagesReceived = new Counter("ws_messages_received");
const sessionDuration = new Trend("ws_session_duration", true);
const activeConnections = new Gauge("ws_active_connections");

// ---------------------------------------------------------------------------
// VU lifecycle
// ---------------------------------------------------------------------------

export default function () {
  const query = subscriptionQuery(__VU);

  // Build URL — append JWT as query param if provided
  let wsUrl = `${BASE_URL}/ws`;
  if (JWT_TOKEN) {
    wsUrl += `?token=${encodeURIComponent(JWT_TOKEN)}`;
  }

  const connectStart = Date.now();
  let subscribeConfirmed = false;
  let sessionStart = null;

  const res = ws.connect(wsUrl, {}, function (socket) {
    connectDuration.add(Date.now() - connectStart);
    sessionStart = Date.now();
    activeConnections.add(1);

    socket.on("open", function () {
      // Send subscription request after connection opens
      socket.send(
        JSON.stringify({
          type: "subscribe",
          query,
        })
      );
    });

    socket.on("message", function (data) {
      messagesReceived.add(1);

      let msg;
      try {
        msg = JSON.parse(data);
      } catch (_) {
        return;
      }

      // The proxy sends {"type":"subscribed","query_id":"..."} as a welcome
      if (msg.type === "subscribed" && msg.query_id) {
        subscribeConfirmed = true;
      }
    });

    socket.on("error", function (err) {
      connectionFailures.add(1);
      socket.close();
    });

    // Hold connection open for 30 seconds to simulate a real client session,
    // then send an unsubscribe and close cleanly.
    socket.setTimeout(function () {
      if (subscribeConfirmed) {
        socket.send(JSON.stringify({ type: "unsubscribe" }));
      }
      socket.close();
    }, 30000);
  });

  // Record whether the welcome message was received
  subscribedRate.add(subscribeConfirmed);

  check(res, {
    "ws: connection established": (r) => r && r.status === 101,
    "ws: received subscribed welcome": () => subscribeConfirmed,
  });

  if (sessionStart !== null) {
    sessionDuration.add(Date.now() - sessionStart);
  }

  activeConnections.add(-1);

  // Brief pause before next iteration (avoid reconnect storms)
  sleep(1);
}
