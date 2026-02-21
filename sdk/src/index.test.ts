import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveQuery, Delta } from "./index.js";

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate async connection
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  // Test helper: simulate server message
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  // Test helper: simulate close
  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiveQuery", () => {
  it("connects to the proxy WebSocket", async () => {
    const lq = new LiveQuery("test_q1", { url: "ws://127.0.0.1:8080" });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://127.0.0.1:8080/ws/test_q1");

    lq.close();
  });

  it("emits connected event on open", async () => {
    const events: string[] = [];
    const lq = new LiveQuery("q1", { url: "ws://127.0.0.1:8080" });
    lq.on((event) => events.push(event));

    // Wait for async onopen
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toContain("connected");
    lq.close();
  });

  it("applies delta to snapshot", async () => {
    const lq = new LiveQuery("q1", { url: "ws://127.0.0.1:8080" });
    const deltas: Delta[] = [];
    lq.on((event, data) => {
      if (event === "delta") deltas.push(data as Delta);
    });

    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.instances[0];

    // Simulate a delta message (flat wire format)
    ws.simulateMessage(
      JSON.stringify({ query_id: "q1", inserted: [{ id: 1, name: "Alice" }], deleted: [] }),
    );

    expect(lq.snapshot).toEqual([{ id: 1, name: "Alice" }]);
    expect(deltas).toHaveLength(1);

    // Another delta with delete + insert
    ws.simulateMessage(
      JSON.stringify({ query_id: "q1", inserted: [{ id: 2, name: "Bob" }], deleted: [{ id: 1, name: "Alice" }] }),
    );

    expect(lq.snapshot).toEqual([{ id: 2, name: "Bob" }]);

    lq.close();
  });

  it("ignores messages for other query_ids", async () => {
    const lq = new LiveQuery("q1", { url: "ws://127.0.0.1:8080" });

    await new Promise((r) => setTimeout(r, 10));
    const ws = MockWebSocket.instances[0];

    ws.simulateMessage(
      JSON.stringify({ query_id: "q2", inserted: [{ id: 99 }], deleted: [] }),
    );

    expect(lq.snapshot).toEqual([]);
    lq.close();
  });

  it("schedules reconnect on close", async () => {
    vi.useFakeTimers();

    const lq = new LiveQuery("q1", {
      url: "ws://127.0.0.1:8080",
      reconnectDelay: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate connection close
    MockWebSocket.instances[0].simulateClose();

    // Fast-forward past reconnect delay
    await vi.advanceTimersByTimeAsync(600);

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    lq.close();
    vi.useRealTimers();
  });

  it("stops reconnecting when closed", async () => {
    vi.useFakeTimers();

    const lq = new LiveQuery("q1", {
      url: "ws://127.0.0.1:8080",
      reconnectDelay: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    lq.close();

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(1000);

    // Should not create new connections after close
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });

  it("unsubscribe removes listener", async () => {
    const lq = new LiveQuery("q1", { url: "ws://127.0.0.1:8080" });
    const events: string[] = [];
    const unsub = lq.on((event) => events.push(event));

    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContain("connected");

    unsub();
    events.length = 0;

    const ws = MockWebSocket.instances[0];
    ws.simulateMessage(
      JSON.stringify({ query_id: "q1", inserted: [{ id: 1 }], deleted: [] }),
    );

    // Listener was removed, so no delta event
    expect(events).toHaveLength(0);

    // But snapshot is still updated (internal)
    expect(lq.snapshot).toEqual([{ id: 1 }]);

    lq.close();
  });
});
