#!/usr/bin/env node
// SECURITY.md trust matrix — WebSocket: open /ws/{queryId} requires
// JWT when REQUIRE_AUTHENTICATED_WS=true.
//
// Round 13, reinforced through 17–22: anon-key holders must NOT
// open a live-query WS when the proxy is in production posture.
//
// Round 32 F2: the previous version of this test sent NO apikey,
// so the upgrade was refused on the trivial "no token at all"
// branch — the REQUIRE_AUTHENTICATED_WS gate (proxy-go/realtime/
// ws.go:112  isAnon && requireAuthenticated) could have been
// deleted entirely and the test would still pass. The test now:
//
//   1. Sends ?apikey=$ANON_KEY so the proxy classifies the client
//      as isAnon=true (the actual code path the gate guards).
//   2. Reads REQUIRE_AUTHENTICATED_WS from its own env and asserts
//      the matching outcome:
//        true  → upgrade MUST be refused (gate fired)
//        false → upgrade MUST succeed (sanity: anon path works at
//                all when the gate is off; future regressions that
//                refuse anon unconditionally also flunk).
//
// CI sets REQUIRE_AUTHENTICATED_WS=true when bringing up the stack
// for the adversarial-security job, so the production-posture
// assertion is what runs there. Locally you can flip it either
// way to verify both legs.

import { WebSocket } from "ws";

const WS_URL = (process.env.PROXY_URL ?? "ws://127.0.0.1:8080").replace(
  /^http/,
  "ws",
);
const ANON_KEY = process.env.ANON_KEY ?? "dev-only-anon-key-do-not-use-in-production";
const REQUIRE = (process.env.REQUIRE_AUTHENTICATED_WS ?? "").toLowerCase() === "true";

function probe() {
  return new Promise((resolve) => {
    // The apikey query param is the supported in-browser auth
    // mechanism for WS — see proxy-go/realtime/ws.go:98. Carrying
    // it here is what makes the proxy classify us as isAnon and
    // exercise the actual gate.
    const ws = new WebSocket(
      `${WS_URL}/ws/probe?apikey=${encodeURIComponent(ANON_KEY)}`,
    );
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(outcome);
    };
    ws.on("open", () => done({ refused: false, reason: "handshake completed" }));
    ws.on("error", (e) => done({ refused: true, reason: e.message || String(e) }));
    ws.on("unexpected-response", (_req, res) =>
      done({ refused: true, reason: `HTTP ${res.statusCode} refused upgrade` }),
    );
    setTimeout(() => done({ refused: false, reason: "timeout (no refusal)" }), 5000);
  });
}

async function main() {
  const out = await probe();
  if (REQUIRE) {
    if (out.refused) {
      console.log(`✓ REQUIRE_AUTHENTICATED_WS=true: anon-key WS upgrade refused (${out.reason})`);
      process.exit(0);
    }
    console.error(`✗ REQUIRE_AUTHENTICATED_WS=true but anon-key WS upgrade was ACCEPTED (${out.reason})`);
    console.error("  the isAnon && requireAuthenticated gate at proxy-go/realtime/ws.go:112 is broken");
    process.exit(1);
  } else {
    if (!out.refused) {
      console.log(`✓ REQUIRE_AUTHENTICATED_WS unset: anon-key WS upgrade succeeded as expected (gate off)`);
      console.log("  (CI runs this same test with REQUIRE_AUTHENTICATED_WS=true to verify the gate fires)");
      process.exit(0);
    }
    console.error(`✗ REQUIRE_AUTHENTICATED_WS unset but anon-key WS upgrade was REFUSED (${out.reason})`);
    console.error("  either the anon-key path is broken OR REQUIRE_AUTHENTICATED_WS is actually enabled in this deployment");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
