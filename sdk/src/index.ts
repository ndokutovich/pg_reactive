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
  type?: "subscribed" | "overflow" | "error";
  query_id: string;
  inserted?: DeltaRow[];
  deleted?: DeltaRow[];
  fetch?: boolean;
}

export type LiveQueryEventType = "delta" | "connected" | "disconnected" | "error";

export type LiveQueryListener = (event: LiveQueryEventType, data?: Delta | Error) => void;

export interface LiveQueryClientOptions {
  /** WebSocket proxy URL, e.g. "ws://127.0.0.1:8080" */
  url: string;

  /** Reconnect delay in ms (default: 1000). Uses exponential backoff with jitter. */
  reconnectDelay?: number;

  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;

  /** Maximum reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
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
    this.url = `${options.url}/ws/${queryId}`;
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
    // Remove deleted rows (match by all columns)
    if (delta.deleted.length > 0) {
      const deleteSet = new Set(delta.deleted.map((r) => JSON.stringify(r)));
      this.rows = this.rows.filter((r) => !deleteSet.has(JSON.stringify(r)));
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

  private emit(event: LiveQueryEventType, data?: Delta | Error): void {
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
