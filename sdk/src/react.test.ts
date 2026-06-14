// @vitest-environment jsdom
//
// Unit tests for the React bindings (FR-B.7.3). These run in a jsdom
// environment with `fetch`, `WebSocket`, and the network mocked, so they
// exercise the hooks' own state logic — not the proxy. LiveQuery is mocked
// so useLiveQuery's event→state reducer is tested in isolation.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock the core module so useLiveQuery wires against a controllable fake.
// vi.mock is hoisted above imports, so the fake class + its instance registry
// must be created via vi.hoisted (which runs first) to be referenceable here.
type EvCb = (ev: string, data?: unknown) => void;
interface FakeLQ {
  queryId: string;
  snapshot: unknown[];
  closed: boolean;
  on(cb: EvCb): () => void;
  close(): void;
  emit(ev: string, data?: unknown): void;
}
const h = vi.hoisted(() => {
  const instances: FakeLQ[] = [];
  class FakeLiveQuery implements FakeLQ {
    queryId: string;
    snapshot: unknown[] = [];
    closed = false;
    cbs: EvCb[] = [];
    constructor(queryId: string) { this.queryId = queryId; instances.push(this); }
    on(cb: EvCb) { this.cbs.push(cb); return () => { this.cbs = this.cbs.filter((c) => c !== cb); }; }
    close() { this.closed = true; }
    emit(ev: string, data?: unknown) { for (const cb of this.cbs) cb(ev, data); }
  }
  return { instances, FakeLiveQuery };
});
vi.mock("./index.js", () => ({ LiveQuery: h.FakeLiveQuery }));

import { useAuth, useLiveQuery, useRpc } from "./react.js";

beforeEach(() => {
  h.instances.length = 0;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const BASE = "http://127.0.0.1:8080";
const USER = { id: "u1", email: "a@b.c", role: "authenticated", user_metadata: {} };

describe("useAuth", () => {
  it("starts unauthenticated and resolves loading=false with no session", async () => {
    const { result } = renderHook(() => useAuth(BASE, "anon-key"));
    // (the mount effect flushes synchronously under renderHook, so the initial
    // loading=true is not separately observable; assert the settled state)
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
  });

  it("signInWithPassword stores the session and sets the user", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/auth/v1/token")) {
        return new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, user: USER }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth(BASE, "anon-key"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: { error: string | null } = { error: "unset" };
    await act(async () => { res = await result.current.signInWithPassword("a@b.c", "pw"); });

    expect(res.error).toBeNull();
    expect(result.current.user?.email).toBe("a@b.c");
    expect(result.current.session?.access_token).toBe("at");
    expect(sessionStorage.getItem("pgstack-session")).toContain("at");
  });

  it("surfaces a server error from signInWithPassword without storing a session", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Invalid login credentials" }), { status: 400 }),
    ) as typeof fetch;

    const { result } = renderHook(() => useAuth(BASE, "anon-key"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let res: { error: string | null } = { error: null };
    await act(async () => { res = await result.current.signInWithPassword("a@b.c", "bad"); });

    expect(res.error).toBe("Invalid login credentials");
    expect(result.current.session).toBeNull();
    expect(sessionStorage.getItem("pgstack-session")).toBeNull();
  });

  it("signOut clears the stored session", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/v1/token")) {
        return new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, user: USER }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth(BASE, "anon-key"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.signInWithPassword("a@b.c", "pw"); });
    expect(sessionStorage.getItem("pgstack-session")).toBeTruthy();

    await act(async () => { await result.current.signOut(); });
    expect(result.current.user).toBeNull();
    expect(sessionStorage.getItem("pgstack-session")).toBeNull();
  });
});

describe("useLiveQuery", () => {
  it("transitions connecting → connected and applies deltas to rows", async () => {
    const { result } = renderHook(() => useLiveQuery("orders_summary", { url: "ws://127.0.0.1:8080" }));
    expect(result.current.state).toBe("connecting");
    const lq = h.instances.at(-1)!;
    expect(lq.queryId).toBe("orders_summary");

    act(() => lq.emit("connected"));
    expect(result.current.state).toBe("connected");

    act(() => { lq.snapshot = [{ id: 1 }]; lq.emit("delta", { inserted: [{ id: 1 }], deleted: [] }); });
    expect(result.current.rows).toEqual([{ id: 1 }]);
    expect(result.current.overflow).toBe(false);
  });

  it("sets overflow and clears rows on an overflow event", async () => {
    const { result } = renderHook(() => useLiveQuery("q", { url: "ws://127.0.0.1:8080" }));
    const lq = h.instances.at(-1)!;
    act(() => { lq.snapshot = [{ id: 1 }]; lq.emit("delta", { inserted: [{ id: 1 }], deleted: [] }); });
    act(() => lq.emit("overflow"));
    expect(result.current.overflow).toBe(true);
    expect(result.current.rows).toEqual([]);
  });

  it("closes the LiveQuery on unmount", () => {
    const { unmount } = renderHook(() => useLiveQuery("q", { url: "ws://127.0.0.1:8080" }));
    const lq = h.instances.at(-1)!;
    unmount();
    expect(lq.closed).toBe(true);
  });
});

describe("useRpc", () => {
  it("executes on mount and exposes the data", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { count: 7 }, error: null }) };
    const { result } = renderHook(() => useRpc(client as never, "get_stats", { since: "2025-01-01" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ count: 7 });
    expect(result.current.error).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith("get_stats", { since: "2025-01-01" }, undefined);
  });

  it("surfaces an RPC error", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) };
    const { result } = renderHook(() => useRpc(client as never, "broken"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("refetch re-invokes the RPC", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: 1, error: null }) };
    const { result } = renderHook(() => useRpc(client as never, "get_stats"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(client.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
  });
});
