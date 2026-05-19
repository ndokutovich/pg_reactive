#!/usr/bin/env node
// SECURITY.md trust matrix — WebSocket: open /ws/{queryId} requires
// JWT when REQUIRE_AUTHENTICATED_WS=true.
//
// Round 13 (and reinforced through rounds 17–22): anon-key holders
// must NOT be able to open a live-query WS to an arbitrary query_id
// when the proxy is configured for production posture. The test
// opens a raw upgrade against /ws/foo without any Authorization /
// apikey / token and expects the handshake to be refused.

import { WebSocket } from "ws";

const WS_URL = (process.env.PROXY_URL ?? "ws://127.0.0.1:8080").replace(
  /^http/,
  "ws",
);

function probe() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}/ws/probe-no-auth`);
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(outcome);
    };
    ws.on("open", () => done({ ok: false, reason: "handshake completed" }));
    ws.on("error", (e) => done({ ok: true, reason: e.message || String(e) }));
    ws.on("unexpected-response", (_req, res) =>
      done({ ok: true, reason: `HTTP ${res.statusCode} refused upgrade` }),
    );
    setTimeout(() => done({ ok: false, reason: "timeout (no refusal)" }), 5000);
  });
}

async function main() {
  const out = await probe();
  if (out.ok) {
    console.log(`✓ anon WS upgrade refused: ${out.reason}`);
    process.exit(0);
  }
  console.error(`✗ anon WS upgrade NOT refused: ${out.reason}`);
  console.error(
    "  REQUIRE_AUTHENTICATED_WS must be true in production posture; " +
    "this test asserts the gate fires for unauthenticated clients.",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(2);
});
