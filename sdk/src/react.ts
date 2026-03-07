/**
 * React bindings for pg-reactive SDK.
 *
 * Provides a `useLiveQuery` hook that subscribes to a live query
 * and returns the current snapshot, delta events, and connection state.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { LiveQuery, LiveQueryClientOptions, DeltaRow, Delta } from "./index.js";
import type { PgStackClient } from "./pgstack.js";

// ---- useAuth ----

export interface User {
  id: string;
  email: string;
  role: string;
  user_metadata: Record<string, unknown>;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix timestamp
}

export interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

const SESSION_KEY = 'pgstack-session';

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (Date.now() / 1000 > s.expires_at) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

function saveSession(s: Session | null) {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

/**
 * Standalone auth hook that manages session in sessionStorage.
 *
 * @param baseUrl - The pgStack proxy URL (e.g. 'http://127.0.0.1:8080')
 * @param anonKey - The anonymous API key
 *
 * @example
 * ```tsx
 * const { user, session, loading, signInWithPassword, signOut } = useAuth(
 *   'http://127.0.0.1:8080',
 *   'anon-key',
 * );
 * ```
 */
export function useAuth(baseUrl: string, anonKey: string) {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: loadSession(),
    loading: true,
  });

  // On mount: if session exists, fetch user; otherwise loading=false
  useEffect(() => {
    const session = loadSession();
    if (!session) { setState(s => ({ ...s, loading: false })); return; }
    fetch(`${baseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => r.ok ? r.json() as Promise<User> : null)
      .then(user => setState({ user, session, loading: false }))
      .catch(() => setState({ user: null, session: null, loading: false }));
  }, [baseUrl]);

  async function signUp(email: string, password: string): Promise<{ error: string | null }> {
    try {
      const r = await fetch(`${baseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json() as Record<string, unknown>;
      if (!r.ok) return { error: (data.error as string) || 'Signup failed' };
      const session: Session = {
        access_token: data.access_token as string,
        refresh_token: data.refresh_token as string,
        expires_at: Math.floor(Date.now() / 1000) + ((data.expires_in as number) ?? 3600),
      };
      saveSession(session);
      setState({ user: data.user as User, session, loading: false });
      return { error: null };
    } catch (e) { return { error: String(e) }; }
  }

  async function signInWithPassword(email: string, password: string): Promise<{ error: string | null }> {
    try {
      const r = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json() as Record<string, unknown>;
      if (!r.ok) return { error: (data.error as string) || 'Sign in failed' };
      const session: Session = {
        access_token: data.access_token as string,
        refresh_token: data.refresh_token as string,
        expires_at: Math.floor(Date.now() / 1000) + ((data.expires_in as number) ?? 3600),
      };
      saveSession(session);
      setState({ user: data.user as User, session, loading: false });
      return { error: null };
    } catch (e) { return { error: String(e) }; }
  }

  async function signOut(): Promise<void> {
    const session = loadSession();
    if (session) {
      await fetch(`${baseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => { /* best-effort server-side revocation; local session cleared regardless */ });
    }
    saveSession(null);
    setState({ user: null, session: null, loading: false });
  }

  async function resetPassword(email: string): Promise<{ error: string | null }> {
    try {
      const r = await fetch(`${baseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return { error: r.ok ? null : 'Failed to send reset email' };
    } catch (e) { return { error: String(e) }; }
  }

  // Auto-refresh: check every minute, refresh 5 minutes before expiry
  useEffect(() => {
    const interval = setInterval(async () => {
      const session = loadSession();
      if (!session) return;
      const expiresIn = session.expires_at - Math.floor(Date.now() / 1000);
      if (expiresIn > 300) return;
      try {
        const r = await fetch(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (r.ok) {
          const data = await r.json() as Record<string, unknown>;
          const newSession: Session = {
            access_token: data.access_token as string,
            refresh_token: data.refresh_token as string,
            expires_at: Math.floor(Date.now() / 1000) + ((data.expires_in as number) ?? 3600),
          };
          saveSession(newSession);
          setState(s => ({ ...s, session: newSession }));
        }
      } catch { /* ignore refresh errors */ }
    }, 60_000);
    return () => clearInterval(interval);
  }, [baseUrl, anonKey]);

  return { ...state, signUp, signInWithPassword, signOut, resetPassword };
}

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

// ---- useRpc ----

export interface UseRpcResult<T = unknown> {
  /** Last result data. */
  data: T | null;
  /** Last error. */
  error: Error | null;
  /** Whether the RPC call is in progress. */
  loading: boolean;
  /** Re-execute the RPC call. */
  refetch: () => void;
}

/**
 * React hook for calling a PostgreSQL RPC function via pgStack REST API.
 *
 * Executes immediately on mount (and when params/fnName change), then
 * exposes a `refetch` function for manual re-execution.
 *
 * @param client - The PgStackClient instance
 * @param fnName - PostgreSQL function name
 * @param params - Optional parameters to pass to the function
 * @param options - Optional configuration (method: 'POST' or 'GET')
 *
 * @example
 * ```tsx
 * const { data, error, loading, refetch } = useRpc(pgstack, 'get_stats', { since: '2025-01-01' })
 * ```
 */
export function useRpc<T = unknown>(
  client: PgStackClient,
  fnName: string,
  params?: Record<string, unknown>,
  options?: { method?: 'POST' | 'GET' },
): UseRpcResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  // Serialize params for dependency tracking
  const paramsKey = params ? JSON.stringify(params) : '';

  const doFetch = useCallback(async () => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const rpcOptions = options?.method === 'GET' ? { get: true } : undefined;
      const res = await client.rpc(fnName, params, rpcOptions);

      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;

      if (res.error) {
        setError(new Error(res.error.message));
        setData(null);
      } else {
        setData(res.data as T);
        setError(null);
      }
    } catch (e) {
      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setData(null);
    } finally {
      if (mountedRef.current && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is JSON.stringify(params) for deep-equality; options object would cause infinite loop
  }, [client, fnName, paramsKey, options?.method]);

  useEffect(() => {
    mountedRef.current = true;
    doFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch]);

  return { data, error, loading, refetch: doFetch };
}
