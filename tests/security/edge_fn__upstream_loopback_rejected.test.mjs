#!/usr/bin/env node
// SECURITY.md cross-cutting invariant #9 — edge function HTTP
// upstreams reject loopback bare hostnames.
//
// Round 21 F3: validateUpstreamURL previously blocked IP literals
// and dotted FQDNs but let "localhost" through. A function pointed
// at http://localhost:8080 looped back to the proxy itself or to
// whatever else was bound to loopback in the container. The unit
// test (proxy-go/functions/http_validate_test.go) covers the Go
// validator directly; this network-level test asserts the gate
// fires when an admin tries to register an http-runtime function
// with a loopback upstream via the REST admin path.
//
// Requires SERVICE_ROLE_KEY (default dev key).

const PROXY = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const SERVICE_KEY =
  process.env.SERVICE_ROLE_KEY ?? "dev-only-service-role-key-do-not-use-in-production";

async function tryRegister(upstream) {
  const res = await fetch(`${PROXY}/functions/v1/_admin/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
    body: JSON.stringify({
      name: `loopback_probe_${Date.now()}`,
      runtime: "http",
      upstream_url: upstream,
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  // If the admin endpoint isn't enabled in this deployment, the
  // first probe returns 404 — that's not a security failure of the
  // validator, just a feature-flag situation. Skip in that case.
  const probe = await tryRegister("http://upstream-service:8080");
  if (probe.status === 404) {
    console.log(
      "skip: /functions/v1/_admin/register not mounted in this deployment",
    );
    process.exit(0);
  }

  const loopbackCases = [
    "http://localhost:8080",
    "http://localhost.localdomain:8080",
    "http://ip6-localhost",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "http://169.254.169.254", // cloud metadata
  ];

  let allRefused = true;
  for (const upstream of loopbackCases) {
    const { status, body } = await tryRegister(upstream);
    if (status === 200 || status === 201) {
      console.error(`✗ ${upstream} accepted (status ${status}) — SSRF guard missing`);
      console.error(`  body: ${body}`);
      allRefused = false;
    } else {
      console.log(`✓ ${upstream} refused (status ${status})`);
    }
  }

  process.exit(allRefused ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
