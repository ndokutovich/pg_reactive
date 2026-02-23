/**
 * React bindings for pg-reactive SDK.
 *
 * Provides a `useLiveQuery` hook that subscribes to a live query
 * and returns the current snapshot, delta events, and connection state.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { LiveQuery, LiveQueryClientOptions, DeltaRow, Delta } from "./index.js";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface UseLiveQueryResult {
  /** Current snapshot of query results */
  rows: ReadonlyArray<DeltaRow>;

  /** Connection state */
  state: ConnectionState;

  /** Last delta received */
  lastDelta: Delta | null;

  /** Whether an overflow occurred (client should re-fetch full state) */
  overflow: boolean;

  /** Whether the query was invalidated (notify mode — client should re-fetch) */
  invalidated: boolean;

  /** Last error */
  error: Error | null;

  /** Manually reconnect */
  reconnect: () => void;
}

/**
 * React hook for subscribing to a pg_reactive live query.
 *
 * @param queryId - The query identifier to subscribe to
 * @param options - WebSocket proxy connection options
 * @returns Current snapshot, connection state, and delta events
 *
 * @example
 * ```tsx
 * const { rows, state } = useLiveQuery("orders_summary", {
 *   url: "ws://127.0.0.1:8080",
 * });
 * ```
 */
export function useLiveQuery(
  queryId: string,
  options: LiveQueryClientOptions,
): UseLiveQueryResult {
  const [rows, setRows] = useState<ReadonlyArray<DeltaRow>>([]);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [lastDelta, setLastDelta] = useState<Delta | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lqRef = useRef<LiveQuery | null>(null);

  const reconnect = useCallback(() => {
    if (lqRef.current) {
      lqRef.current.close();
    }
    lqRef.current = new LiveQuery(queryId, options);
    setState("connecting");
  }, [queryId, options.url]);

  useEffect(() => {
    const lq = new LiveQuery(queryId, options);
    lqRef.current = lq;

    const unsubscribe = lq.on((event, data) => {
      switch (event) {
        case "connected":
          setState("connected");
          setError(null);
          break;
        case "disconnected":
          setState("disconnected");
          break;
        case "delta":
          setRows([...lq.snapshot]);
          setLastDelta(data as Delta);
          setOverflow(false);
          setInvalidated(false);
          break;
        case "overflow":
          setRows([]);
          setOverflow(true);
          break;
        case "invalidated":
          setInvalidated(true);
          break;
        case "error":
          setError(data as Error);
          break;
      }
    });

    return () => {
      unsubscribe();
      lq.close();
      lqRef.current = null;
    };
  }, [queryId, options.url]);

  return { rows, state, lastDelta, overflow, invalidated, error, reconnect };
}
