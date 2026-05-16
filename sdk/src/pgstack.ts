/**
 * pgStack SDK — Supabase-compatible client for pgStack.
 *
 * Usage:
 *   import { createClient } from '@pgstack/sdk'
 *   const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key')
 *   const { data } = await pgstack.from('todos').select('*')
 */

import { PgStackAuth, type AuthSession } from './auth-client.js';
import { PgStackQueryBuilder } from './query-builder.js';
import { RealtimeChannel } from './index.js';
import { StorageClient } from './storage.js';

export interface PgStackClientOptions {
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
  /** Auto-refresh JWT tokens (default: true) */
  autoRefreshToken?: boolean;
  /**
   * Persist session to sessionStorage (default: true in browser).
   * sessionStorage is tab-scoped — closing the browser logs the user
   * out. The React `useAuth` hook uses the same storage. Set false to
   * keep the session in memory only.
   */
  persistSession?: boolean;
}

export class PgStackClient {
  readonly url: string;
  readonly auth: PgStackAuth;
  private anonKey: string;
  private _accessToken: string | null = null;
  private _storage: StorageClient | null = null;

  constructor(url: string, anonKey: string, options?: PgStackClientOptions) {
    // Normalize: strip trailing slash
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.auth = new PgStackAuth(this.url, anonKey, {
      autoRefreshToken: options?.autoRefreshToken ?? true,
    });

    // Listen for auth state changes to update the access token
    this.auth.onAuthStateChange((event, session) => {
      this._accessToken = session?.access_token ?? null;
    });
  }

  /** Storage client for file upload, download, and management. */
  get storage(): StorageClient {
    if (!this._storage) {
      this._storage = new StorageClient(this.url, () => this.getHeaders());
    }
    return this._storage;
  }

  /** Start building a query on a table with an optional row type parameter. */
  from<T = Record<string, unknown>>(table: string): PgStackQueryBuilder<T> {
    return new PgStackQueryBuilder<T>(this.url, table, () => this.getHeaders());
  }

  /** Create a general-purpose realtime channel. */
  channel(name: string): RealtimeChannel {
    return new RealtimeChannel(name, this.url, this._accessToken ?? undefined);
  }

  /** Call an RPC (PostgreSQL function). */
  async rpc(
    fn: string,
    params?: Record<string, unknown>,
    options?: { head?: boolean; get?: boolean },
  ): Promise<{ data: unknown; error: PgStackError | null }> {
    const method = options?.get ? 'GET' : 'POST';
    let path = `/rest/v1/rpc/${fn}`;

    if (method === 'GET' && params) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      path += `?${qs}`;
    }

    const headers = this.getHeaders();
    const fetchOpts: RequestInit = { method, headers };

    if (method === 'POST' && params) {
      fetchOpts.body = JSON.stringify(params);
    }

    try {
      const res = await fetch(`${this.url}${path}`, fetchOpts);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }
      const data = await res.json();
      return { data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /** Execute multiple REST operations in a single database transaction. */
  async batch(
    operations: BatchOperation[],
    options?: { atomic?: boolean },
  ): Promise<{ data: BatchResponse | null; error: PgStackError | null }> {
    try {
      const res = await fetch(`${this.url}/rest/v1/batch`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          atomic: options?.atomic ?? true,
          operations,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) {
        return {
          data: null,
          error: {
            message: body.error || res.statusText,
            status: res.status,
          },
        };
      }
      return { data: body as BatchResponse, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }

  /** Access the edge functions client. */
  get functions(): EdgeFunctionsClient {
    if (!this._functionsClient) {
      this._functionsClient = new EdgeFunctionsClient(this.url, () => this.getHeaders());
    }
    return this._functionsClient;
  }

  private _functionsClient?: EdgeFunctionsClient;

  /** Get the current auth headers. */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._accessToken || this.anonKey}`,
    };
    return headers;
  }
}

/** A single operation in a batch request. */
export interface BatchOperation {
  id?: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: string;
  body?: unknown;
}

/** Result of a single operation within a batch. */
export interface BatchResult {
  id: string;
  status: number;
  data?: unknown;
  error?: string;
}

/** Response from POST /rest/v1/batch. */
export interface BatchResponse {
  results: BatchResult[];
  error?: string;
  failed_operation?: string;
}

export interface PgStackError {
  message: string;
  status: number;
}

/** Client for invoking edge functions via /functions/v1/{name}. */
export class EdgeFunctionsClient {
  constructor(
    private url: string,
    private headersFn: () => Record<string, string>,
  ) {}

  /** Invoke an edge function by name. */
  async invoke<T = unknown>(
    name: string,
    options?: {
      body?: unknown;
      method?: 'POST' | 'GET';
      headers?: Record<string, string>;
    },
  ): Promise<{ data: T | null; error: PgStackError | null }> {
    const method = options?.method ?? 'POST';
    const headers = { ...this.headersFn(), ...options?.headers };

    const fetchOpts: RequestInit = { method, headers };
    if (method === 'POST' && options?.body !== undefined) {
      fetchOpts.body = JSON.stringify(options.body);
    }

    try {
      const res = await fetch(`${this.url}/functions/v1/${encodeURIComponent(name)}`, fetchOpts);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: {
            message: (body as Record<string, string>).error || res.statusText,
            status: res.status,
          },
        };
      }
      const data = (await res.json()) as T;
      return { data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: 0,
        },
      };
    }
  }
}

/**
 * Create a pgStack client.
 *
 * @param url - The pgStack proxy URL (e.g. 'http://127.0.0.1:8080')
 * @param anonKey - The anonymous API key
 * @param options - Optional client configuration
 */
export function createClient(
  url: string,
  anonKey: string,
  options?: PgStackClientOptions,
): PgStackClient {
  return new PgStackClient(url, anonKey, options);
}

// Re-export RealtimeChannel so consumers can import from pgstack entry point
export { RealtimeChannel } from './index.js';
