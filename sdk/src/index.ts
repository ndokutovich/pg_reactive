/**
 * pg-reactive SDK
 *
 * Client library for subscribing to pg_reactive live queries
 * via WebSocket proxy.
 */

export type DeltaRow = Record<string, unknown>;

export interface Delta {
  query_id: string;
  inserted: DeltaRow[];
  deleted: DeltaRow[];
}

/**
 * Wire format from the proxy. Messages are either:
 * - Subscribed: {"type":"subscribed","query_id":"..."}
 * - Delta (flat): {"query_id":"...","inserted":[...],"deleted":[...]}
 * - Overflow: {"type":"overflow","query_id":"...","fetch":true}
 */
export interface LiveQueryMessage {
  type?: "subscribed" | "overflow" | "error" | "invalidated";
  query_id: string;
  inserted?: DeltaRow[];
  deleted?: DeltaRow[];
  fetch?: boolean;
}

export interface Invalidation {
  query_id: string;
}

export interface Overflow {
  query_id: string;
  fetch: boolean;
}

export type LiveQueryEventType = "delta" | "overflow" | "invalidated" | "connected" | "disconnected" | "error";

export type LiveQueryListener = (event: LiveQueryEventType, data?: Delta | Overflow | Invalidation | Error) => void;

export interface LiveQueryClientOptions {
  /** WebSocket proxy URL, e.g. "ws://127.0.0.1:8080" */
  url: string;

  /** JWT token for authentication (passed as ?token= query param) */
  token?: string;

  /** Reconnect delay in ms (default: 1000). Uses exponential backoff with jitter. */
  reconnectDelay?: number;

  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;

  /** Maximum reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

/**
 * Produce a canonical string key for a row, independent of property order.
 * Sorts keys alphabetically so {b:2,a:1} and {a:1,b:2} produce the same key.
 */
function rowKey(row: DeltaRow): string {
  const sorted = Object.keys(row).sort();
  return JSON.stringify(sorted.map((k) => [k, row[k]]));
}

/**
 * A live query subscription. Connects to the proxy WebSocket,
 * receives delta messages, and maintains a local snapshot of the query results.
 */
export class LiveQuery {
  readonly queryId: string;
  private url: string;
  private ws: WebSocket | null = null;
  private listeners: LiveQueryListener[] = [];
  private rows: DeltaRow[] = [];
  private reconnectDelay: number;
  private maxReconnectDelay: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(queryId: string, options: LiveQueryClientOptions) {
    this.queryId = queryId;
    const tokenParam = options.token ? `?token=${encodeURIComponent(options.token)}` : "";
    this.url = `${options.url}/ws/${queryId}${tokenParam}`;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
    this.connect();
  }

  /** Current snapshot of query results */
  get snapshot(): ReadonlyArray<DeltaRow> {
    return this.rows;
  }

  /** Register an event listener */
  on(listener: LiveQueryListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Close the connection and stop reconnecting */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit("connected");
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onclose = () => {
      this.emit("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, so reconnect happens there
    };
  }

  private handleMessage(data: string): void {
    let msg: LiveQueryMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "subscribed") {
      // Connection confirmed
      return;
    }

    if (msg.query_id !== this.queryId) return;

    // Overflow: payload was too large or client lagged, clear local snapshot
    if (msg.type === "overflow") {
      this.rows = [];
      this.emit("overflow", { query_id: msg.query_id, fetch: msg.fetch ?? true });
      return;
    }

    // Invalidated: notify-mode signal, data changed but no delta provided
    if (msg.type === "invalidated") {
      this.emit("invalidated", { query_id: msg.query_id });
      return;
    }

    // Delta messages are flat: {query_id, inserted, deleted}
    if (msg.inserted || msg.deleted) {
      const delta: Delta = {
        query_id: msg.query_id,
        inserted: msg.inserted ?? [],
        deleted: msg.deleted ?? [],
      };
      this.applyDelta(delta);
      this.emit("delta", delta);
    }
  }

  /** Apply a delta to the local snapshot */
  private applyDelta(delta: Delta): void {
    // Remove deleted rows (match by deep equality)
    if (delta.deleted.length > 0) {
      const deleteSet = new Set(delta.deleted.map(rowKey));
      this.rows = this.rows.filter((r) => !deleteSet.has(rowKey(r)));
    }

    // Add inserted rows
    if (delta.inserted.length > 0) {
      this.rows = [...this.rows, ...delta.inserted];
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) +
        Math.random() * 500,
      this.maxReconnectDelay,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private emit(event: LiveQueryEventType, data?: Delta | Overflow | Invalidation | Error): void {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch {
        // swallow listener errors
      }
    }
  }
}

/**
 * Create a new live query subscription.
 */
export function subscribe(
  queryId: string,
  options: LiveQueryClientOptions,
): LiveQuery {
  return new LiveQuery(queryId, options);
}

// ---- RealtimeChannel ----

export type ChannelEvent = 'message' | 'error' | 'connected' | 'disconnected';
export type ChannelCallback = (event: ChannelEvent, data?: unknown) => void;

/**
 * A general-purpose WebSocket channel for pub/sub messaging.
 *
 * @example
 * ```ts
 * const ch = client.channel('presence');
 * ch.subscribe((event, data) => console.log(event, data));
 * ch.send({ user: 'alice', status: 'online' });
 * // later:
 * ch.unsubscribe();
 * ```
 */
export class RealtimeChannel {
  private ws: WebSocket | null = null;
  private listeners: ChannelCallback[] = [];
  private channelName: string;
  private wsUrl: string;
  private token: string | undefined;

  constructor(channelName: string, wsUrl: string, token?: string) {
    this.channelName = channelName;
    this.wsUrl = wsUrl;
    this.token = token;
  }

  /** Register a callback and connect if this is the first subscriber. */
  subscribe(callback: ChannelCallback): this {
    this.listeners.push(callback);
    if (this.listeners.length === 1) this.connect();
    return this;
  }

  /** Send a payload to the channel. No-op if the socket is not yet open. */
  send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ channel: this.channelName, payload }));
    }
  }

  /** Remove all callbacks and close the WebSocket connection. */
  unsubscribe(): void {
    this.listeners = [];
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const url = new URL(this.wsUrl.replace(/^http/, 'ws') + `/ws/_channel_${this.channelName}`);
    if (this.token) url.searchParams.set('token', this.token);
    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => this.emit('connected');
    this.ws.onclose = () => this.emit('disconnected');
    this.ws.onerror = () => this.emit('error');
    this.ws.onmessage = (e) => {
      try { this.emit('message', JSON.parse(e.data as string)); }
      catch { this.emit('message', e.data); }
    };
  }

  private emit(event: ChannelEvent, data?: unknown): void {
    this.listeners.forEach(cb => cb(event, data));
  }
}

/**
 * A client that manages multiple live query subscriptions with shared options.
 */
export interface LiveQueryClient {
  /** Subscribe to a live query by ID */
  subscribe(queryId: string): LiveQuery;

  /** Create a general-purpose realtime channel */
  channel(name: string): RealtimeChannel;

  /** Close all active subscriptions */
  close(): void;
}

/**
 * Create a client that manages multiple live queries with shared connection options.
 *
 * @example
 * ```ts
 * const client = createClient({ url: "ws://127.0.0.1:8080", token: "..." });
 * const orders = client.subscribe("orders_q");
 * const users = client.subscribe("users_q");
 * // later:
 * client.close(); // closes all
 * ```
 */
export function createClient(options: LiveQueryClientOptions): LiveQueryClient {
  const queries: LiveQuery[] = [];

  return {
    subscribe(queryId: string): LiveQuery {
      const lq = new LiveQuery(queryId, options);
      queries.push(lq);
      return lq;
    },

    channel(name: string): RealtimeChannel {
      return new RealtimeChannel(name, options.url, options.token);
    },

    close(): void {
      for (const lq of queries) {
        lq.close();
      }
      queries.length = 0;
    },
  };
}
