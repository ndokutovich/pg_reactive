/**
 * React bindings for pgStack SDK.
 *
 * Provides context, auth hooks, and data-fetching hooks
 * for the Supabase-compatible pgStack REST API.
 *
 * @example
 * ```tsx
 * import { PgStackProvider, useAuth, useQuery } from '@pgstack/sdk/pgstack-react'
 *
 * function App() {
 *   return (
 *     <PgStackProvider client={pgstack}>
 *       <Todos />
 *     </PgStackProvider>
 *   )
 * }
 *
 * function Todos() {
 *   const { data, error, loading, refetch } = useQuery('todos', q => q.select('*').eq('done', false))
 *   const { user, signOut } = useAuth()
 *   // ...
 * }
 * ```
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { PgStackClient } from './pgstack.js';
import type { AuthUser, AuthSession, AuthChangeEvent } from './auth-client.js';
import { PgStackQueryBuilder, type PgStackResponse } from './query-builder.js';

// ---- Context ----

const PgStackContext = createContext<PgStackClient | null>(null);

export interface PgStackProviderProps {
  client: PgStackClient;
  children: ReactNode;
}

/** Provide the pgStack client to all child components. */
export function PgStackProvider({ client, children }: PgStackProviderProps) {
  return <PgStackContext.Provider value={client}>{children}</PgStackContext.Provider>;
}

/** Get the pgStack client from context. Throws if used outside PgStackProvider. */
export function usePgStack(): PgStackClient {
  const client = useContext(PgStackContext);
  if (!client) {
    throw new Error('usePgStack must be used within a <PgStackProvider>');
  }
  return client;
}

// ---- useAuth ----

export interface UseAuthResult {
  /** Current user (null if not signed in). */
  user: AuthUser | null;
  /** Current session (null if not signed in). */
  session: AuthSession | null;
  /** Whether the initial auth state is still loading. */
  loading: boolean;
  /** Sign up with email and password. */
  signUp: (email: string, password: string, data?: Record<string, unknown>) => Promise<void>;
  /** Sign in with email and password. */
  signIn: (email: string, password: string) => Promise<void>;
  /** Sign out. */
  signOut: () => Promise<void>;
}

/**
 * Hook for auth state and actions.
 * Subscribes to auth state changes and keeps user/session in sync.
 */
export function useAuth(): UseAuthResult {
  const client = usePgStack();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange(
      (_event: AuthChangeEvent, sess: AuthSession | null) => {
        setSession(sess);
        setUser(sess?.user ?? null);
        setLoading(false);
      },
    );

    // If no session was emitted synchronously, check getSession
    client.auth.getSession().then(({ data }) => {
      if (data.session) {
        setSession(data.session);
        setUser(data.session.user);
      }
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [client]);

  const signUp = useCallback(
    async (email: string, password: string, data?: Record<string, unknown>) => {
      const { error } = await client.auth.signUp({
        email,
        password,
        options: data ? { data } : undefined,
      });
      if (error) throw new Error(error.message);
    },
    [client],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    [client],
  );

  const signOut = useCallback(async () => {
    const { error } = await client.auth.signOut();
    if (error) throw new Error(error.message);
  }, [client]);

  return { user, session, loading, signUp, signIn, signOut };
}

// ---- useQuery ----

export interface UseQueryResult<T = unknown> {
  /** Query result data. */
  data: T | null;
  /** Error from the last fetch. */
  error: { message: string; status: number } | null;
  /** Whether the query is currently loading. */
  loading: boolean;
  /** Re-fetch the query. */
  refetch: () => void;
  /** Total count (if requested via select options). */
  count: number | null;
  /** HTTP status code from last response. */
  status: number | null;
}

type QueryBuilderFn = (builder: PgStackQueryBuilder) => PgStackQueryBuilder | PromiseLike<PgStackResponse>;

/**
 * Hook for fetching data from a table via the REST API.
 *
 * @param table - Table name
 * @param builderFn - Function that configures the query (select, filter, order, etc.)
 * @param deps - Additional dependencies that trigger re-fetch
 *
 * @example
 * ```tsx
 * const { data, loading } = useQuery('todos', q => q.select('*').eq('done', false))
 * ```
 */
export function useQuery<T = unknown>(
  table: string,
  builderFn?: QueryBuilderFn,
  deps: unknown[] = [],
): UseQueryResult<T> {
  const client = usePgStack();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  const doFetch = useCallback(async () => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      let builder = client.from(table);
      if (builderFn) {
        const result = builderFn(builder);
        if (result instanceof PgStackQueryBuilder) {
          builder = result;
        }
      }

      // Await the thenable query builder
      const res: PgStackResponse = await builder;

      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;

      if (res.error) {
        setError(res.error);
        setData(null);
      } else {
        setData(res.data as T);
        setError(null);
      }
      setCount(res.count);
      setStatus(res.status);
    } catch (e) {
      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;
      setError({
        message: e instanceof Error ? e.message : String(e),
        status: 0,
      });
      setData(null);
    } finally {
      if (mountedRef.current && fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, table, ...deps]);

  useEffect(() => {
    mountedRef.current = true;
    doFetch();
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch]);

  return { data, error, loading, refetch: doFetch, count, status };
}

// ---- useRpc ----

export interface UseRpcResult<T = unknown> {
  /** Execute the RPC call. */
  execute: (params?: Record<string, unknown>) => Promise<T | null>;
  /** Last result data. */
  data: T | null;
  /** Last error. */
  error: { message: string; status: number } | null;
  /** Whether the RPC is currently executing. */
  loading: boolean;
}

/**
 * Hook for calling RPC functions.
 *
 * @param fn - PostgreSQL function name
 *
 * @example
 * ```tsx
 * const { execute, data, loading } = useRpc('add_numbers')
 * // later: await execute({ a: 5, b: 3 })
 * ```
 */
export function useRpc<T = unknown>(fn: string): UseRpcResult<T> {
  const client = usePgStack();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (params?: Record<string, unknown>): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.rpc(fn, params);
        if (!mountedRef.current) return null;
        if (res.error) {
          setError(res.error);
          setData(null);
          return null;
        }
        const result = res.data as T;
        setData(result);
        return result;
      } catch (e) {
        if (!mountedRef.current) return null;
        const err = {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        };
        setError(err);
        setData(null);
        return null;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [client, fn],
  );

  return { execute, data, error, loading };
}

// ---- useMutation ----

export interface UseMutationResult {
  /** Insert row(s). */
  insert: (values: Record<string, unknown> | Record<string, unknown>[]) => Promise<PgStackResponse>;
  /** Update row(s) matching the builder filters. */
  update: (values: Record<string, unknown>, builderFn?: (b: PgStackQueryBuilder) => PgStackQueryBuilder) => Promise<PgStackResponse>;
  /** Delete row(s) matching the builder filters. */
  remove: (builderFn?: (b: PgStackQueryBuilder) => PgStackQueryBuilder) => Promise<PgStackResponse>;
  /** Whether a mutation is in progress. */
  loading: boolean;
  /** Last error. */
  error: { message: string; status: number } | null;
}

/**
 * Hook for mutations (insert, update, delete).
 *
 * @param table - Table name
 *
 * @example
 * ```tsx
 * const { insert, update, remove, loading } = useMutation('todos')
 * await insert({ title: 'New todo' })
 * await update({ done: true }, q => q.eq('id', 1))
 * await remove(q => q.eq('id', 1))
 * ```
 */
export function useMutation(table: string): UseMutationResult {
  const client = usePgStack();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);

  const insert = useCallback(
    async (values: Record<string, unknown> | Record<string, unknown>[]): Promise<PgStackResponse> => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.from(table).insert(values);
        if (res.error) setError(res.error);
        return res;
      } finally {
        setLoading(false);
      }
    },
    [client, table],
  );

  const update = useCallback(
    async (
      values: Record<string, unknown>,
      builderFn?: (b: PgStackQueryBuilder) => PgStackQueryBuilder,
    ): Promise<PgStackResponse> => {
      setLoading(true);
      setError(null);
      try {
        let builder = client.from(table);
        if (builderFn) builder = builderFn(builder);
        const res = await builder.update(values);
        if (res.error) setError(res.error);
        return res;
      } finally {
        setLoading(false);
      }
    },
    [client, table],
  );

  const remove = useCallback(
    async (builderFn?: (b: PgStackQueryBuilder) => PgStackQueryBuilder): Promise<PgStackResponse> => {
      setLoading(true);
      setError(null);
      try {
        let builder = client.from(table);
        if (builderFn) builder = builderFn(builder);
        const res = await builder.delete();
        if (res.error) setError(res.error);
        return res;
      } finally {
        setLoading(false);
      }
    },
    [client, table],
  );

  return { insert, update, remove, loading, error };
}

// Re-export live query hook and standalone auth hook from react.ts
export { useLiveQuery, type UseLiveQueryResult, type ConnectionState } from './react.js';
export { useAuth as useStandaloneAuth, type User, type Session, type AuthState } from './react.js';
