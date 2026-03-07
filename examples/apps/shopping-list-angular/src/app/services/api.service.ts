import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

const m = location.pathname.match(/^(.*?)\/apps\//);
const base = m ? m[1] : '';
const API_BASE = location.origin + base;
export const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;

const ANON_KEY = 'anon-key-12345';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private auth: AuthService) {}

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY
    };
    const token = this.auth.getToken();
    if (token) {
      h['Authorization'] = 'Bearer ' + token;
    }
    return h;
  }

  async apiSql(sql: string): Promise<{ error?: string; rows?: unknown[] }> {
    const res = await fetch(API_BASE + '/api/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql })
    });
    return res.json();
  }

  async apiRest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.doRest<T>(method, path, body);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        const refreshed = await this.auth.tryRefresh();
        if (refreshed) return this.doRest<T>(method, path, body);
      }
      throw err;
    }
  }

  private async doRest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = {
      method,
      headers: this.authHeaders()
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API_BASE + '/rest/v1/' + path, opts);
    if (res.status === 204) {
      return null as T;
    }
    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || data.message || JSON.stringify(data), res.status);
    }
    return data as T;
  }

  async apiRpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T> {
    try {
      return await this.doRpc<T>(fn, params);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        const refreshed = await this.auth.tryRefresh();
        if (refreshed) return this.doRpc<T>(fn, params);
      }
      throw err;
    }
  }

  private async doRpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(API_BASE + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(params || {})
    });
    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || data.message || JSON.stringify(data), res.status);
    }
    return data as T;
  }
}
