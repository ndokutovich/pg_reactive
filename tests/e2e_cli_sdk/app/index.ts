// Dogfood app: uses the PUBLISHED-or-PACKED @pgstack/sdk to open a live query
// against a real pgStack backend and assert a delta arrives. The whole point is
// that this file is compiled (tsc) and run with the SDK installed exactly as a
// new user gets it — so a broken package, broken types, or broken WS wire format
// fails here, where unit tests can't see it.
import { createClient } from "@pgstack/sdk";

const url = process.env.PGSTACK_URL || "ws://127.0.0.1:8080";
const token = process.env.ANON_KEY || "";
const QUERY_ID = process.env.QUERY_ID || "cli_sdk_e2e_q";
const EXPECT = process.env.EXPECT_ROW || "cli_sdk_e2e_row";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

const client = createClient({ url, token });
const q = client.subscribe(QUERY_ID);

let done = false;
function check(): void {
  if (done) return;
  const hit = q.snapshot.some((r: Record<string, unknown>) => r.name === EXPECT);
  if (hit) {
    done = true;
    // eslint-disable-next-line no-console
    console.log("DELTA_OK: live row received through @pgstack/sdk");
    client.close();
    process.exit(0);
  }
}

q.on(() => check());

// The runner triggers the INSERT only after it sees this line, so the WS is
// already bound — no race where the delta fires before we subscribe.
setTimeout(() => console.log("SUBSCRIBED"), 1500);

setTimeout(() => {
  console.error(`TIMEOUT: no '${EXPECT}' delta within ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS);
