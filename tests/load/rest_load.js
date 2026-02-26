/**
 * k6 load test: REST API endpoint throughput and latency
 *
 * Covers:
 *  - GET /rest/v1/{table}        — list rows (no filter)
 *  - GET /rest/v1/{table}?filter — filtered rows
 *  - GET /rest/v1/{table}?limit&offset — paginated rows
 *  - POST /rest/v1/{table}       — insert a row
 *  - PATCH /rest/v1/{table}?id=eq.X — update a row
 *  - DELETE /rest/v1/{table}?id=eq.X — delete a row
 *
 * Prerequisites: docker compose up -d
 * The test assumes a "load_test_items" table exists and is accessible.
 * Create it with:
 *   CREATE TABLE IF NOT EXISTS load_test_items (
 *     id   SERIAL PRIMARY KEY,
 *     name TEXT NOT NULL,
 *     val  INTEGER DEFAULT 0
 *   );
 *   GRANT ALL ON load_test_items TO authenticated;
 *
 * Usage:
 *   k6 run tests/load/rest_load.js
 *   k6 run --env BASE_URL=http://127.0.0.1:8080 --env TABLE=my_table tests/load/rest_load.js
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8080";
const TABLE = __ENV.TABLE || "load_test_items";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";

export const options = {
  scenarios: {
    read_heavy: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 50 },
        { duration: "40s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      tags: { workload: "read" },
    },
    write_mixed: {
      executor: "constant-vus",
      vus: 10,
      duration: "60s",
      startTime: "5s",
      tags: { workload: "write" },
      exec: "writeMixed",
    },
  },

  thresholds: {
    // p95 latency for reads must be under 200 ms.
    "http_req_duration{workload:read}": ["p(95)<200"],

    // p95 latency for writes (insert/update/delete) under 500 ms.
    "http_req_duration{workload:write}": ["p(95)<500"],

    // Overall error rate must stay below 1 %.
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: false }],

    // Custom success rate must exceed 99 %.
    rest_success_rate: ["rate>0.99"],
  },
};

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const restSuccessRate = new Rate("rest_success_rate");
const listDuration = new Trend("list_duration_ms", true);
const filterDuration = new Trend("filter_duration_ms", true);
const insertDuration = new Trend("insert_duration_ms", true);
const deleteDuration = new Trend("delete_duration_ms", true);
const errorCount = new Counter("rest_errors");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headers() {
  const h = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) {
    h["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  return h;
}

function url(path) {
  return `${BASE_URL}${path}`;
}

// ---------------------------------------------------------------------------
// Read-heavy scenario (default)
// ---------------------------------------------------------------------------

export default function () {
  group("list all rows", () => {
    const start = Date.now();
    const res = http.get(url(`/rest/v1/${TABLE}`), { headers: headers() });
    listDuration.add(Date.now() - start);

    const ok = check(res, {
      "list: status 200": (r) => r.status === 200,
      "list: body is array": (r) => {
        try {
          return Array.isArray(JSON.parse(r.body));
        } catch (_) {
          return false;
        }
      },
    });
    restSuccessRate.add(ok);
    if (!ok) errorCount.add(1);
  });

  group("paginated rows", () => {
    const start = Date.now();
    const res = http.get(url(`/rest/v1/${TABLE}?limit=10&offset=0`), {
      headers: headers(),
    });
    listDuration.add(Date.now() - start);

    const ok = check(res, {
      "paginate: status 200": (r) => r.status === 200,
      "paginate: at most 10 rows": (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body) && body.length <= 10;
        } catch (_) {
          return false;
        }
      },
    });
    restSuccessRate.add(ok);
    if (!ok) errorCount.add(1);
  });

  group("filtered rows", () => {
    const start = Date.now();
    const res = http.get(url(`/rest/v1/${TABLE}?val=gte.0&limit=5`), {
      headers: headers(),
    });
    filterDuration.add(Date.now() - start);

    const ok = check(res, {
      "filter: status 200": (r) => r.status === 200,
    });
    restSuccessRate.add(ok);
    if (!ok) errorCount.add(1);
  });

  sleep(Math.random() * 0.1);
}

// ---------------------------------------------------------------------------
// Write-mixed scenario
// ---------------------------------------------------------------------------

export function writeMixed() {
  // Insert a row
  const name = `item_${__VU}_${__ITER}`;
  const insertPayload = JSON.stringify({ name, val: __ITER });

  let insertedId = null;

  group("insert row", () => {
    const start = Date.now();
    const res = http.post(url(`/rest/v1/${TABLE}`), insertPayload, {
      headers: headers(),
    });
    insertDuration.add(Date.now() - start);

    const ok = check(res, {
      "insert: status 201 or 200": (r) => r.status === 201 || r.status === 200,
      "insert: returns id": (r) => {
        try {
          const body = JSON.parse(r.body);
          const rows = Array.isArray(body) ? body : [body];
          if (rows.length > 0 && rows[0].id) {
            insertedId = rows[0].id;
            return true;
          }
          return false;
        } catch (_) {
          return false;
        }
      },
    });
    restSuccessRate.add(ok);
    if (!ok) errorCount.add(1);
  });

  // Delete the just-inserted row (if we got an ID back)
  if (insertedId !== null) {
    group("delete row", () => {
      const start = Date.now();
      const res = http.del(url(`/rest/v1/${TABLE}?id=eq.${insertedId}`), null, {
        headers: headers(),
      });
      deleteDuration.add(Date.now() - start);

      const ok = check(res, {
        "delete: status 200": (r) => r.status === 200,
      });
      restSuccessRate.add(ok);
      if (!ok) errorCount.add(1);
    });
  }

  sleep(Math.random() * 0.2);
}
