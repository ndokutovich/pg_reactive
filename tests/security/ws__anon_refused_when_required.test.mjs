#!/usr/bin/env node
// SECURITY.md trust matrix — WebSocket: open /ws/{queryId} requires
// JWT when REQUIRE_AUTHENTICATED_WS=true.
//
// Round 13, reinforced through 17–22: anon-key holders must NOT
// open a live-query WS when the proxy is in production posture.
//
// Round 32 F2: an earlier version sent no apikey, so the upgrade was
// refused on the trivial "no token at all" branch — the gate could
// have been deleted and the test still passed. It then sent ?apikey
// but accepted ANY refusal.
//
// Gen-ordering-audit P2: that "any refusal" check was still a false
// positive. The test connected to an UNREGISTERED query_id, so with
// the gate deleted the proxy would 404 ("subscription not found") —
// and a 404 counted as a pass. The order of checks in WSHandler is
// exactly why this matters: `isAnon && requireAuthenticated` returns
// 401 BEFORE subscriptionMeta is consulted, so the gate's own
// response is 401, while a missing gate falls through to the 404.
//
// This version therefore:
//   1. Registers a real PUBLIC subscription `probe`, so with the gate
//      OFF an anon client SUCCEEDS (not 404) — that is what makes a
//      deleted gate observable.
//   2. Sends ?apikey=$ANON_KEY (classifies the client as isAnon).
//   3. Reads REQUIRE_AUTHENTICATED_WS from its own env and asserts:
//        true  → upgrade MUST be refused with HTTP 401 specifically
//                (the gate's response — a 404/other refusal flunks).
//        false → upgrade MUST succeed (anon path works when gate off).
//
// CI sets REQUIRE_AUTHENTICATED_WS=true and brings the stack up, so
// the production-posture assertion is what runs there.

import { WebSocket } from "ws";
import { psql } from "../helpers.mjs";

const WS_URL = (process.env.PROXY_URL ?? "ws://127.0.0.1:8080").replace(
  /^http/,
  "ws",
);
const ANON_KEY = process.env.ANON_KEY ?? "dev-only-anon-key-do-not-use-in-production";
const REQUIRE = (process.env.REQUIRE_AUTHENTICATED_WS ?? "").toLowerCase() === "true";

const QID = "probe";

// Register a real PUBLIC subscription so the gate (not a missing-subscription
// 404) is what the probe observes. Fail loudly if setup cannot run — a test
// that cannot establish its precondition must not silently "pass".
function setup() {
  try {
    psql("CREATE EXTENSION IF NOT EXISTS pg_reactive;");
    psql("DROP TABLE IF EXISTS probe_t CASCADE;");
    psql("CREATE TABLE probe_t (id int primary key);");
    psql(`SELECT pgr.unsubscribe('${QID}');`);
    psql(`SELECT pgr.subscribe('${QID}', 'SELECT id FROM probe_t', 'delta', NULL);`);
  } catch (e) {
    console.error("✗ setup failed — cannot register the public probe subscription:", e.message ?? e);
    process.exit(2);
  }
}

function cleanup() {
  try {
    psql(`SELECT pgr.unsubscribe('${QID}');`);
    psql("DROP TABLE IF EXISTS probe_t CASCADE;");
  } catch { /* best effort */ }
}

function probe() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}/ws/${QID}?apikey=${encodeURIComponent(ANON_KEY)}`);
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(outcome);
    };
    ws.on("open", () => done({ refused: false, status: 101, reason: "handshake completed" }));
    // HTTP-level refusal (401/404/…): status is authoritative.
    ws.on("unexpected-response", (_req, res) =>
      done({ refused: true, status: res.statusCode, reason: `HTTP ${res.statusCode} refused upgrade` }),
    );
    // Connection-level error with no HTTP status (status stays undefined).
    ws.on("error", (e) => done({ refused: true, status: undefined, reason: e.message || String(e) }));
    setTimeout(() => done({ refused: false, status: 0, reason: "timeout (no refusal)" }), 5000);
  });
}

async function main() {
  setup();
  let code = 0;
  try {
    const out = await probe();
    if (REQUIRE) {
      // Must be refused, and refused SPECIFICALLY with 401 — the gate's own
      // response. A 404 (missing subscription) or any other refusal means the
      // gate did not fire and something else rejected us: that is the false
      // positive we are closing.
      if (out.refused && out.status === 401) {
        console.log(`✓ REQUIRE_AUTHENTICATED_WS=true: anon-key WS upgrade refused with 401 (gate fired)`);
      } else {
        console.error(`✗ REQUIRE_AUTHENTICATED_WS=true expected HTTP 401, got: ${out.reason}`);
        console.error("  the isAnon && requireAuthenticated gate (proxy-go/realtime/ws.go) did not fire;");
        console.error("  a non-401 refusal (e.g. 404) would have masked a deleted gate.");
        code = 1;
      }
    } else {
      if (!out.refused) {
        console.log(`✓ REQUIRE_AUTHENTICATED_WS unset: anon-key WS upgrade succeeded on the public subscription (gate off)`);
        console.log("  (CI runs this same test with REQUIRE_AUTHENTICATED_WS=true to verify the gate fires with 401)");
      } else {
        console.error(`✗ REQUIRE_AUTHENTICATED_WS unset but anon-key WS upgrade was REFUSED (${out.reason})`);
        console.error("  either the anon-key path is broken OR REQUIRE_AUTHENTICATED_WS is actually enabled here.");
        code = 1;
      }
    }
  } finally {
    cleanup();
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("test harness error:", e);
  cleanup();
  process.exit(2);
});
