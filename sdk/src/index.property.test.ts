import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import type { Delta, DeltaRow, LiveQueryMessage, LiveQueryEventType } from './index.js';

// ---- Mock WebSocket ----

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate synchronous open for property test determinism
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(_data: string) {}

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  // unstubAllGlobals reverts vi.stubGlobal — see index.test.ts for the
  // full story. Required to keep the WebSocket stub from leaking between
  // files when vitest reuses workers.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Arbitraries ----

/** Valid query ID: alphanumeric with underscores, 1-30 chars. */
const queryIdArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,29}$/);

/** Simple row with string/number values. */
const rowArb: fc.Arbitrary<DeltaRow> = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/),
  fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/),
    fc.boolean(),
    fc.constant(null),
  ),
  { minKeys: 1, maxKeys: 5 },
);

/** Array of unique rows (by rowKey). */
const uniqueRowsArb = (minLen: number, maxLen: number): fc.Arbitrary<DeltaRow[]> =>
  fc.array(rowArb, { minLength: minLen, maxLength: maxLen }).map((rows) => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = canonicalRowKey(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/** Base URL without trailing slash. */
const baseUrlArb = fc.oneof(
  fc.constant('ws://127.0.0.1:8080'),
  fc.constant('wss://example.com'),
  fc.constant('ws://my-proxy.internal:3000'),
  fc
    .tuple(
      fc.constantFrom('ws', 'wss'),
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
      fc.integer({ min: 1024, max: 65535 }),
    )
    .map(([proto, host, port]) => `${proto}://${host}:${port}`),
);

/** JWT-like token (base64url chars). */
const tokenArb = fc.stringMatching(/^[A-Za-z0-9_-]{10,50}$/);

/**
 * Canonical key matching the production rowKey function logic.
 * Sorts keys alphabetically, serializes as JSON array of [key, value] pairs.
 */
function canonicalRowKey(row: DeltaRow): string {
  const sorted = Object.keys(row).sort();
  return JSON.stringify(sorted.map((k) => [k, row[k]]));
}

// ---- Property Tests: SDK Index Module ----

describe('LiveQuery property-based tests', () => {
  // Property 1: WebSocket URL construction
  // For any base URL and query_id, the constructed WS URL contains /ws/<queryId>
  // and preserves the protocol.
  it('constructs valid WS URL with query_id in path', async () => {
    // Dynamic import to get the class after the mock is set up
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(queryIdArb, baseUrlArb, async (queryId, url) => {
        MockWebSocket.instances = [];
        const lq = new LiveQuery(queryId, { url });

        expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
        const wsUrl = MockWebSocket.instances[MockWebSocket.instances.length - 1].url;

        // URL must contain /ws/<queryId>
        expect(wsUrl).toContain(`/ws/${queryId}`);

        // Protocol must start with ws:// or wss://
        expect(wsUrl).toMatch(/^wss?:\/\//);

        // The base host must be preserved
        const baseHost = url.replace(/^wss?:\/\//, '').split('/')[0];
        expect(wsUrl).toContain(baseHost);

        lq.close();
      }),
      { numRuns: 100 },
    );
  });

  // Property 2: Token is URL-encoded in query parameter
  it('includes token as URL-encoded query parameter', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(queryIdArb, baseUrlArb, tokenArb, async (queryId, url, token) => {
        MockWebSocket.instances = [];
        const lq = new LiveQuery(queryId, { url, token });

        const wsUrl = MockWebSocket.instances[MockWebSocket.instances.length - 1].url;

        // Must contain token= query param with encoded value
        expect(wsUrl).toContain(`?token=${encodeURIComponent(token)}`);

        lq.close();
      }),
      { numRuns: 100 },
    );
  });

  // Property 3: No token param when token is undefined
  it('omits token param when no token provided', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(queryIdArb, baseUrlArb, async (queryId, url) => {
        MockWebSocket.instances = [];
        const lq = new LiveQuery(queryId, { url });

        const wsUrl = MockWebSocket.instances[MockWebSocket.instances.length - 1].url;

        expect(wsUrl).not.toContain('?token=');
        expect(wsUrl).not.toContain('&token=');

        lq.close();
      }),
      { numRuns: 50 },
    );
  });

  // Property 4: Message type detection — subscribed messages are silently consumed
  // (no delta emitted), overflow clears snapshot, delta updates snapshot.
  it('classifies message types correctly: subscribed, overflow, delta, invalidated', async () => {
    const { LiveQuery } = await import('./index.js');

    const messageTypeArb = fc.oneof(
      // Subscribed message
      queryIdArb.map((qid) => ({
        kind: 'subscribed' as const,
        msg: JSON.stringify({ type: 'subscribed', query_id: qid }),
        queryId: qid,
      })),
      // Overflow message
      queryIdArb.map((qid) => ({
        kind: 'overflow' as const,
        msg: JSON.stringify({ type: 'overflow', query_id: qid, fetch: true }),
        queryId: qid,
      })),
      // Invalidated message
      queryIdArb.map((qid) => ({
        kind: 'invalidated' as const,
        msg: JSON.stringify({ type: 'invalidated', query_id: qid }),
        queryId: qid,
      })),
      // Delta message (no type field, has inserted/deleted)
      fc.tuple(queryIdArb, fc.array(rowArb, { minLength: 0, maxLength: 3 })).map(
        ([qid, rows]) => ({
          kind: 'delta' as const,
          msg: JSON.stringify({ query_id: qid, inserted: rows, deleted: [] }),
          queryId: qid,
        }),
      ),
    );

    await fc.assert(
      fc.asyncProperty(messageTypeArb, async ({ kind, msg, queryId }) => {
        MockWebSocket.instances = [];
        const events: LiveQueryEventType[] = [];

        const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });
        lq.on((event) => events.push(event));

        // Wait for onopen
        await new Promise((r) => setTimeout(r, 5));
        const ws = MockWebSocket.instances[0];
        events.length = 0; // clear "connected" event

        ws.simulateMessage(msg);

        if (kind === 'subscribed') {
          // Subscribed messages are consumed silently — no event emitted
          expect(events).not.toContain('delta');
          expect(events).not.toContain('overflow');
          expect(events).not.toContain('invalidated');
        } else if (kind === 'overflow') {
          expect(events).toContain('overflow');
          expect(lq.snapshot).toEqual([]);
        } else if (kind === 'invalidated') {
          expect(events).toContain('invalidated');
        } else if (kind === 'delta') {
          const parsed = JSON.parse(msg);
          if (parsed.inserted?.length > 0 || parsed.deleted?.length > 0) {
            expect(events).toContain('delta');
          }
        }

        lq.close();
      }),
      { numRuns: 200 },
    );
  });

  // Property 5: Delta application — insert adds rows, delete removes rows.
  // |final| = |original| - |deleted that matched| + |inserted|
  it('delta application: final count = original - matched_deletes + inserts', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        uniqueRowsArb(1, 10),
        uniqueRowsArb(0, 5),
        async (queryId, initialRows, newRows) => {
          MockWebSocket.instances = [];
          const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Seed initial rows
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: initialRows, deleted: [] }),
          );
          expect(lq.snapshot.length).toBe(initialRows.length);

          // Now delete some of the initial rows and insert new ones
          const toDelete = initialRows.slice(0, Math.min(3, initialRows.length));
          ws.simulateMessage(
            JSON.stringify({
              query_id: queryId,
              inserted: newRows,
              deleted: toDelete,
            }),
          );

          const expectedCount = initialRows.length - toDelete.length + newRows.length;
          expect(lq.snapshot.length).toBe(expectedCount);

          // All new rows must be present in the snapshot
          const snapshotKeys = new Set(lq.snapshot.map(canonicalRowKey));
          for (const row of newRows) {
            expect(snapshotKeys.has(canonicalRowKey(row))).toBe(true);
          }

          // All deleted rows must be absent
          for (const row of toDelete) {
            expect(snapshotKeys.has(canonicalRowKey(row))).toBe(false);
          }

          lq.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 6: rowKey is order-independent — {a:1, b:2} and {b:2, a:1} produce
  // the same key, so deleting one removes the other.
  it('row matching is property-order-independent', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        fc.record({
          a: fc.integer(),
          b: fc.stringMatching(/^[a-z]{1,5}$/),
        }),
        async (queryId, fields) => {
          MockWebSocket.instances = [];
          const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Insert with one key order
          const row1 = { a: fields.a, b: fields.b };
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: [row1], deleted: [] }),
          );
          expect(lq.snapshot.length).toBe(1);

          // Delete with reversed key order
          const row2 = { b: fields.b, a: fields.a };
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: [], deleted: [row2] }),
          );
          expect(lq.snapshot.length).toBe(0);

          lq.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 7: Messages for other query_ids are ignored
  it('ignores messages targeting a different query_id', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        queryIdArb.filter((id) => id.length > 1),
        fc.array(rowArb, { minLength: 1, maxLength: 5 }),
        async (queryId, otherIdBase, rows) => {
          // Ensure the IDs differ
          const otherId = otherIdBase === queryId ? `x${otherIdBase}` : otherIdBase;

          MockWebSocket.instances = [];
          const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Send delta for a different query_id
          ws.simulateMessage(
            JSON.stringify({ query_id: otherId, inserted: rows, deleted: [] }),
          );

          // Snapshot must remain empty
          expect(lq.snapshot).toEqual([]);

          lq.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 8: Overflow clears snapshot regardless of how many rows were present
  it('overflow clears all rows from snapshot', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        uniqueRowsArb(0, 20),
        async (queryId, rows) => {
          MockWebSocket.instances = [];
          const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Seed rows
          if (rows.length > 0) {
            ws.simulateMessage(
              JSON.stringify({ query_id: queryId, inserted: rows, deleted: [] }),
            );
            expect(lq.snapshot.length).toBe(rows.length);
          }

          // Overflow clears everything
          ws.simulateMessage(
            JSON.stringify({ type: 'overflow', query_id: queryId, fetch: true }),
          );
          expect(lq.snapshot).toEqual([]);

          lq.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 9: listener unsubscribe prevents further event delivery
  it('unsubscribed listener receives no further events', async () => {
    const { LiveQuery } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        fc.array(rowArb, { minLength: 1, maxLength: 3 }),
        async (queryId, rows) => {
          MockWebSocket.instances = [];
          const events: LiveQueryEventType[] = [];
          const lq = new LiveQuery(queryId, { url: 'ws://127.0.0.1:8080' });

          const unsub = lq.on((event) => events.push(event));
          await new Promise((r) => setTimeout(r, 5));

          // Unsubscribe
          unsub();
          events.length = 0;

          const ws = MockWebSocket.instances[0];
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: rows, deleted: [] }),
          );

          // No events delivered
          expect(events.length).toBe(0);

          // But snapshot was still updated internally
          expect(lq.snapshot.length).toBe(rows.length);

          lq.close();
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('createClient property-based tests', () => {
  // Property 10: createClient URL normalization — all subscriptions
  // share the same base URL and token
  it('all subscriptions from same client use same base URL and token', async () => {
    const { createClient } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        baseUrlArb,
        tokenArb,
        fc.array(queryIdArb, { minLength: 1, maxLength: 5 }),
        async (url, token, queryIds) => {
          // Deduplicate query IDs
          const uniqueIds = [...new Set(queryIds)];
          if (uniqueIds.length === 0) return;

          MockWebSocket.instances = [];
          const client = createClient({ url, token });

          const lqs = uniqueIds.map((id) => client.subscribe(id));

          expect(MockWebSocket.instances.length).toBe(uniqueIds.length);

          for (let i = 0; i < uniqueIds.length; i++) {
            const wsUrl = MockWebSocket.instances[i].url;
            // Each must contain the query_id
            expect(wsUrl).toContain(`/ws/${uniqueIds[i]}`);
            // Each must contain the token
            expect(wsUrl).toContain(`token=${encodeURIComponent(token)}`);
            // Each must start with the base protocol
            const expectedProto = url.startsWith('wss') ? 'wss://' : 'ws://';
            expect(wsUrl.startsWith(expectedProto)).toBe(true);
          }

          client.close();
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 11: close() closes all subscriptions
  it('close() closes all WebSocket connections', async () => {
    const { createClient } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        fc.array(queryIdArb, { minLength: 1, maxLength: 5 }),
        async (queryIds) => {
          const uniqueIds = [...new Set(queryIds)];
          if (uniqueIds.length === 0) return;

          MockWebSocket.instances = [];
          const client = createClient({ url: 'ws://127.0.0.1:8080' });
          uniqueIds.forEach((id) => client.subscribe(id));

          await new Promise((r) => setTimeout(r, 5));

          client.close();

          // All connections must be closed (readyState=3)
          for (const ws of MockWebSocket.instances) {
            expect(ws.readyState).toBe(3);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('LiveQueryHub property-based tests', () => {
  // Property 12: mutation queue respects maxOfflineQueue
  it('mutation queue drops oldest when exceeding maxOfflineQueue', async () => {
    const { LiveQueryHub } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 50 }),
        async (maxQueue, numMutations) => {
          const hub = new LiveQueryHub({
            url: 'ws://127.0.0.1:8080',
            maxOfflineQueue: maxQueue,
          });

          // Queue mutations (hub is not connected, so mutate() queues them)
          for (let i = 0; i < numMutations; i++) {
            hub.queueMutation(async () => {});
          }

          // Pending mutations should never exceed maxQueue
          expect(hub.pendingMutations).toBeLessThanOrEqual(maxQueue);

          // If we queued more than max, should be exactly at max
          if (numMutations >= maxQueue) {
            expect(hub.pendingMutations).toBe(maxQueue);
          } else {
            expect(hub.pendingMutations).toBe(numMutations);
          }

          hub.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 13: close() clears mutation queue and subscriptions
  it('close() clears all state', async () => {
    const { LiveQueryHub } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        fc.array(queryIdArb, { minLength: 0, maxLength: 5 }),
        fc.integer({ min: 0, max: 10 }),
        async (queryIds, numMutations) => {
          const uniqueIds = [...new Set(queryIds)];

          MockWebSocket.instances = [];
          const hub = new LiveQueryHub({ url: 'ws://127.0.0.1:8080' });

          // Subscribe to queries
          uniqueIds.forEach((id) => hub.subscribe(id));

          // Queue some mutations
          for (let i = 0; i < numMutations; i++) {
            hub.queueMutation(async () => {});
          }

          hub.close();

          expect(hub.pendingMutations).toBe(0);

          // All WebSocket connections should be closed
          for (const ws of MockWebSocket.instances) {
            expect(ws.readyState).toBe(3);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 14: subscribe() with same queryId returns same subscription (dedup)
  it('subscribe() deduplicates by queryId', async () => {
    const { LiveQueryHub } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(queryIdArb, async (queryId) => {
        MockWebSocket.instances = [];
        const hub = new LiveQueryHub({ url: 'ws://127.0.0.1:8080' });

        const sub1 = hub.subscribe(queryId);
        const sub2 = hub.subscribe(queryId);

        // Must return the same object
        expect(sub1).toBe(sub2);

        // Only one WebSocket connection should exist
        expect(MockWebSocket.instances.length).toBe(1);

        hub.close();
      }),
      { numRuns: 50 },
    );
  });
});

describe('HubSubscription optimistic update properties', () => {
  // Property 15: optimisticInsert + rollback returns to original state
  it('rollback after optimistic insert restores original snapshot', async () => {
    const { LiveQueryHub } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        uniqueRowsArb(1, 5),
        rowArb,
        async (queryId, initialRows, newRow) => {
          MockWebSocket.instances = [];
          const hub = new LiveQueryHub({ url: 'ws://127.0.0.1:8080' });
          const sub = hub.subscribe(queryId);

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Seed initial rows
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: initialRows, deleted: [] }),
          );
          const snapshotBefore = [...sub.snapshot];

          // Optimistic insert
          sub.optimisticInsert(newRow);
          expect(sub.snapshot.length).toBe(snapshotBefore.length + 1);

          // Rollback
          sub.rollback();

          // Snapshot must match original (same length and same row keys)
          expect(sub.snapshot.length).toBe(snapshotBefore.length);
          const keys = new Set(sub.snapshot.map(canonicalRowKey));
          for (const row of snapshotBefore) {
            expect(keys.has(canonicalRowKey(row))).toBe(true);
          }

          hub.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property 16: optimisticDelete + rollback restores original state
  it('rollback after optimistic delete restores original snapshot', async () => {
    const { LiveQueryHub } = await import('./index.js');

    await fc.assert(
      fc.asyncProperty(
        queryIdArb,
        uniqueRowsArb(2, 8),
        async (queryId, initialRows) => {
          MockWebSocket.instances = [];
          const hub = new LiveQueryHub({ url: 'ws://127.0.0.1:8080' });
          const sub = hub.subscribe(queryId);

          await new Promise((r) => setTimeout(r, 5));
          const ws = MockWebSocket.instances[0];

          // Seed initial rows
          ws.simulateMessage(
            JSON.stringify({ query_id: queryId, inserted: initialRows, deleted: [] }),
          );
          const snapshotBefore = [...sub.snapshot];

          // Optimistic delete of first row
          sub.optimisticDelete(initialRows[0]);
          expect(sub.snapshot.length).toBe(snapshotBefore.length - 1);

          // Rollback
          sub.rollback();

          // Snapshot must match original count
          expect(sub.snapshot.length).toBe(snapshotBefore.length);

          hub.close();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('PgStackClient URL normalization properties', () => {
  // Property 17: trailing slashes are stripped
  it('strips trailing slashes from base URL', async () => {
    const { PgStackClient } = await import('./pgstack.js');

    const urlWithSlashesArb = fc
      .tuple(
        fc.constantFrom('http://127.0.0.1:8080', 'https://api.example.com'),
        fc.stringMatching(/^\/{1,5}$/),
      )
      .map(([base, slashes]) => base + slashes);

    await fc.assert(
      fc.property(urlWithSlashesArb, (url) => {
        // PgStackClient strips trailing slashes
        const client = new PgStackClient(url, 'test-key');
        expect(client.url).not.toMatch(/\/$/);
        expect(client.url.length).toBeGreaterThan(0);
      }),
      { numRuns: 50 },
    );
  });
});

describe('Wire message JSON round-trip properties', () => {
  // Property 18: any valid LiveQueryMessage can be serialized and parsed
  it('LiveQueryMessage round-trips through JSON', () => {
    const liveQueryMessageArb: fc.Arbitrary<LiveQueryMessage> = fc.oneof(
      // Subscribed
      queryIdArb.map((qid) => ({ type: 'subscribed' as const, query_id: qid })),
      // Overflow
      queryIdArb.map((qid) => ({
        type: 'overflow' as const,
        query_id: qid,
        fetch: true,
      })),
      // Invalidated
      queryIdArb.map((qid) => ({ type: 'invalidated' as const, query_id: qid })),
      // Delta (no type field)
      fc
        .tuple(
          queryIdArb,
          fc.array(rowArb, { minLength: 0, maxLength: 5 }),
          fc.array(rowArb, { minLength: 0, maxLength: 5 }),
        )
        .map(([qid, ins, del]) => ({
          query_id: qid,
          inserted: ins,
          deleted: del,
        })),
    );

    fc.assert(
      fc.property(liveQueryMessageArb, (msg) => {
        const serialized = JSON.stringify(msg);
        const parsed = JSON.parse(serialized) as LiveQueryMessage;

        expect(parsed.query_id).toBe(msg.query_id);

        if (msg.type) {
          expect(parsed.type).toBe(msg.type);
        }
        if (msg.inserted) {
          expect(parsed.inserted).toEqual(msg.inserted);
        }
        if (msg.deleted) {
          expect(parsed.deleted).toEqual(msg.deleted);
        }
      }),
      { numRuns: 200 },
    );
  });
});
