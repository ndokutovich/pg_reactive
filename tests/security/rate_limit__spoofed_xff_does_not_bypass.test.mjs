#!/usr/bin/env node
// SECURITY.md invariant #4 — XFF only honoured from TRUSTED_PROXIES.
//
// Round 22 F1 (Medium): nginx's $proxy_add_x_forwarded_for appends
// the client IP to whatever XFF the client supplied. The proxy
// previously took XFF[0] (leftmost), which is the spoofed value.
// Round 25 (HIGH): chi.RealIP also rewrote RemoteAddr from spoofed
// headers, defeating the trusted-proxy check entirely.
//
// This test rotates a fake X-Forwarded-For per request from the
// loopback (an untrusted source unless TRUSTED_PROXIES explicitly
// lists 127.0.0.1). If the rate limiter is keyed off the spoofed
// header, every request gets its own bucket and we never hit the
// cap. If the limiter is correctly keyed off the kernel-attested
// real IP, we WILL hit the cap (default AUTH_RATE_LIMIT=30/min).

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const N = 40; // > default AUTH_RATE_LIMIT=30

async function hit(i) {
  const res = await fetch(`${PROXY}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Rotating per-request spoof. If the proxy honours this from
      // an untrusted source we'd never hit the cap.
      "x-forwarded-for": `10.${i % 256}.${Math.floor(i / 256) % 256}.1`,
    },
    body: JSON.stringify({
      email: "not-a-real-user@example.com",
      password: "wrong",
    }),
  });
  return res.status;
}

async function main() {
  const statuses = [];
  for (let i = 0; i < N; i++) {
    statuses.push(await hit(i));
  }
  const limited = statuses.filter((s) => s === 429).length;

  if (limited > 0) {
    console.log(
      `✓ ${limited}/${N} requests hit the rate limiter despite rotating XFF spoof`,
    );
    process.exit(0);
  }

  // 0 of 40 hit 429 → either rate-limiter is disabled (env mis-set
  // for this test run) or the spoof worked. Both are reportable:
  // operator must enable AUTH_RATE_LIMIT to use this test.
  console.error(
    `✗ none of ${N} requests were rate-limited — either AUTH_RATE_LIMIT is unset ` +
    `or the proxy is honouring spoofed X-Forwarded-For from untrusted source.`,
  );
  console.error(`statuses observed: ${[...new Set(statuses)].join(", ")}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
