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

export interface PgStackClientOptions {
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
  /** Auto-refresh JWT tokens (default: true) */
  autoRefreshToken?: boolean;
  /** Persist session to localStorage (default: true in browser) */
  persistSession?: boolean;
}

export class PgStackClient {
  readonly url: string;
  readonly auth: PgStackAuth;
  private anonKey: string;
  private _accessToken: string | null = null;

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

  /** Get the current auth headers. */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._accessToken || this.anonKey}`,
    };
    return headers;
  }
}

export interface PgStackError {
  message: string;
  status: number;
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
