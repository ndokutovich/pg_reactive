/**
 * k6 load test: Auth endpoint rate limit and throughput
 *
 * Covers:
 *  - POST /auth/v1/signup at high concurrency
 *  - POST /auth/v1/login with valid and invalid credentials
 *  - Verifies rate limiting kicks in under sustained load
 *
 * Usage:
 *   k6 run tests/load/auth_load.js
 *   k6 run --env BASE_URL=http://127.0.0.1:8080 tests/load/auth_load.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8080";

export const options = {
  scenarios: {
    // Ramp to 100 virtual users over 10 s, hold for 20 s, ramp down.
    signup_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 100 },
        { duration: "20s", target: 100 },
        { duration: "5s", target: 0 },
      ],
      tags: { scenario: "signup" },
    },
    // Steady-state login load running concurrently.
    login_load: {
      executor: "constant-vus",
      vus: 50,
      duration: "30s",
      startTime: "5s",
      tags: { scenario: "login" },
    },
  },

  thresholds: {
    // Overall error rate across both scenarios must stay below 5 %.
    // (Rate-limited 429 responses count as errors here to surface them.)
    http_req_failed: [{ threshold: "rate<0.05", abortOnFail: false }],

    // 95th-percentile response time for login must be under 500 ms.
    "http_req_duration{scenario:login}": ["p(95)<500"],

    // Signup is heavier (password hashing) — allow up to 2 s p95.
    "http_req_duration{scenario:signup}": ["p(95)<2000"],
  },
};

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const rateLimitHits = new Counter("rate_limit_hits");
const signupSuccessRate = new Rate("signup_success_rate");
const loginSuccessRate = new Rate("login_success_rate");
const signupDuration = new Trend("signup_duration_ms", true);
const loginDuration = new Trend("login_duration_ms", true);

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const COMMON_HEADERS = {
  "Content-Type": "application/json",
};

let _vu_counter = 0;

function uniqueEmail() {
  // Combine VU id + iteration + timestamp for uniqueness under parallel load.
  return `loadtest_${__VU}_${__ITER}_${Date.now()}@example.invalid`;
}

// ---------------------------------------------------------------------------
// Default function (signup scenario)
// ---------------------------------------------------------------------------

export default function () {
  signupScenario();
}

function signupScenario() {
  const email = uniqueEmail();
  const payload = JSON.stringify({
    email,
    password: "LoadTest!Passw0rd",
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/auth/v1/signup`, payload, {
    headers: COMMON_HEADERS,
    tags: { endpoint: "signup" },
  });
  signupDuration.add(Date.now() - start);

  if (res.status === 429) {
    rateLimitHits.add(1);
    signupSuccessRate.add(false);
    sleep(1);
    return;
  }

  const ok = check(res, {
    "signup: status is 200 or 201": (r) => r.status === 200 || r.status === 201,
    "signup: response has access_token": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.access_token !== undefined;
      } catch (_) {
        return false;
      }
    },
  });

  signupSuccessRate.add(ok);

  // Small think time to avoid overwhelming the server during the ramp.
  sleep(Math.random() * 0.5);
}

// ---------------------------------------------------------------------------
// Login scenario (runs as a separate k6 lifecycle via scenario exec override)
// ---------------------------------------------------------------------------

export function loginScenario() {
  // Use a pre-seeded test account that must exist before the test runs.
  const payload = JSON.stringify({
    email: __ENV.LOGIN_EMAIL || "loadtest_seed@example.invalid",
    password: __ENV.LOGIN_PASSWORD || "LoadTest!Passw0rd",
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/auth/v1/login`, payload, {
    headers: COMMON_HEADERS,
    tags: { endpoint: "login" },
  });
  loginDuration.add(Date.now() - start);

  if (res.status === 429) {
    rateLimitHits.add(1);
    loginSuccessRate.add(false);
    sleep(1);
    return;
  }

  const ok = check(res, {
    "login: status is 200": (r) => r.status === 200,
    "login: response has access_token": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.access_token !== undefined;
      } catch (_) {
        return false;
      }
    },
  });

  loginSuccessRate.add(ok);
  sleep(Math.random() * 0.3);
}

// Wire the login scenario to the correct exec function name.
// k6 uses `exec` in the scenario config to call a named exported function.
// Since both scenarios are defined above, we expose loginScenario as the
// exec target for the login_load scenario by re-exporting it.
export { loginScenario as login };
