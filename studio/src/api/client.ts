import { useAuthStore } from '../store/auth.store';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(
    _baseUrl: string,
    private readonly key: string
  ) {}

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.key}`,
    };
  }

  private async handleResponse<T>(res: Response): Promise<T | undefined> {
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        message = body.error ?? body.message ?? message;
      } catch {
        // ignore JSON parse errors
      }
      throw new ApiError(res.status, message);
    }
    const text = await res.text();
    if (!text) return undefined; // 204 No Content
    return JSON.parse(text) as T;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T | undefined> {
    const url = new URL(path, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    const res = await fetch(url.toString(), { headers: this.headers });
    return this.handleResponse<T>(res);
  }

  async post<T>(path: string, body?: unknown): Promise<T | undefined> {
    const res = await fetch(path, {
      method: 'POST',
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res);
  }

  async patch<T>(path: string, body: unknown): Promise<T | undefined> {
    const res = await fetch(path, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(res);
  }

  async delete<T>(path: string, params?: Record<string, string>): Promise<T | undefined> {
    const url = new URL(path, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: this.headers,
    });
    return this.handleResponse<T>(res);
  }
}

export function getApiClient(): ApiClient {
  const key = useAuthStore.getState().serviceRoleKey ?? '';
  return new ApiClient('', key);
}
