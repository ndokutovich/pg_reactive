/**
 * pgStack Auth Client — Supabase-compatible auth API.
 */

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  user_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type AuthChangeEvent =
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED';

export type AuthStateChangeCallback = (
  event: AuthChangeEvent,
  session: AuthSession | null,
) => void;

export interface AuthOptions {
  autoRefreshToken?: boolean;
  /** Automatically detect OAuth session in URL hash fragment (default: true). */
  detectSessionInUrl?: boolean;
}

export interface OAuthSessionResult {
  session: AuthSession | null;
  error: AuthError | null;
}

export class PgStackAuth {
  private url: string;
  private anonKey: string;
  private session: AuthSession | null = null;
  private listeners: AuthStateChangeCallback[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRefresh: boolean;
  private detectSessionInUrl: boolean;
  private _initialized: Promise<void>;

  constructor(url: string, anonKey: string, options?: AuthOptions) {
    this.url = url;
    this.anonKey = anonKey;
    this.autoRefresh = options?.autoRefreshToken ?? true;
    this.detectSessionInUrl = options?.detectSessionInUrl ?? true;
    this._initialized = this._initialize();
  }

  private async _initialize(): Promise<void> {
    if (this.detectSessionInUrl && typeof window !== 'undefined') {
      await this.handleOAuthRedirect();
    }
  }

  /**
   * Parse an OAuth redirect hash fragment and establish the session.
   *
   * After an OAuth provider redirects back to your app, the URL contains
   * a hash fragment like:
   *   http://app.com/#access_token=xxx&refresh_token=yyy&expires_in=3600&token_type=bearer
   *
   * This method parses those parameters, fetches the user profile,
   * stores the session, fires the SIGNED_IN event, and clears the hash.
   *
   * @returns The session if tokens were found, or null with an error.
   */
  async handleOAuthRedirect(): Promise<OAuthSessionResult> {
    if (typeof window === 'undefined') {
      return { session: null, error: null };
    }

    const hash = window.location.hash;
    if (!hash || hash.length <= 1) {
      return { session: null, error: null };
    }

    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn = params.get('expires_in');
    const tokenType = params.get('token_type');

    if (!accessToken) {
      return { session: null, error: null };
    }

    try {
      // Fetch user profile using the access token
      const res = await this.fetch('/auth/v1/user', 'GET', undefined, accessToken);
      if (res.error) {
        return { session: null, error: res.error };
      }

      const user = res.data as AuthUser;
      const session: AuthSession = {
        access_token: accessToken,
        refresh_token: refreshToken ?? '',
        expires_in: expiresIn ? parseInt(expiresIn, 10) : 3600,
        token_type: tokenType ?? 'bearer',
        user,
      };

      this.setSession(session);

      // Clear the hash from the URL without triggering a navigation
      window.history.replaceState(null, '', window.location.pathname + window.location.search);

      return { session, error: null };
    } catch (e) {
      const error: AuthError = {
        message: e instanceof Error ? e.message : String(e),
        status: 0,
      };
      return { session: null, error };
    }
  }

  /** Sign up with email and password. */
  async signUp(credentials: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown> };
  }): Promise<{ data: { user: AuthUser; session: AuthSession } | null; error: AuthError | null }> {
    const body: Record<string, unknown> = {
      email: credentials.email,
      password: credentials.password,
    };
    if (credentials.options?.data) {
      body.data = credentials.options.data;
    }

    const res = await this.fetch('/auth/v1/signup', 'POST', body);
    if (res.error) return { data: null, error: res.error };

    const session = res.data as AuthSession;
    this.setSession(session);
    return {
      data: { user: session.user, session },
      error: null,
    };
  }

  /** Sign in with email and password. */
  async signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ data: { user: AuthUser; session: AuthSession } | null; error: AuthError | null }> {
    const body = {
      email: credentials.email,
      password: credentials.password,
      grant_type: 'password',
    };

    const res = await this.fetch('/auth/v1/token', 'POST', body);
    if (res.error) return { data: null, error: res.error };

    const session = res.data as AuthSession;
    this.setSession(session);
    return {
      data: { user: session.user, session },
      error: null,
    };
  }

  /** Sign in with an OAuth provider (Google, GitHub). Redirects the browser. */
  async signInWithOAuth(options: {
    provider: 'google' | 'github';
    options?: { redirectTo?: string };
  }): Promise<{ data: { provider: string; url: string } | null; error: AuthError | null }> {
    const redirectTo = options.options?.redirectTo
      ? `&redirect_to=${encodeURIComponent(options.options.redirectTo)}`
      : '';
    const url = `${this.url}/auth/v1/authorize?provider=${options.provider}${redirectTo}`;

    // In a browser environment, redirect automatically
    if (typeof window !== 'undefined') {
      window.location.href = url;
    }

    return {
      data: { provider: options.provider, url },
      error: null,
    };
  }

  /** Sign out the current user. */
  async signOut(): Promise<{ error: AuthError | null }> {
    if (!this.session) return { error: null };

    const res = await this.fetch('/auth/v1/logout', 'POST', {}, this.session.access_token);
    this.clearSession();
    return { error: res.error };
  }

  /** Get the current session. */
  async getSession(): Promise<{
    data: { session: AuthSession | null };
    error: null;
  }> {
    return { data: { session: this.session }, error: null };
  }

  /** Get the current user. */
  async getUser(): Promise<{
    data: { user: AuthUser | null };
    error: AuthError | null;
  }> {
    if (!this.session) return { data: { user: null }, error: null };

    const res = await this.fetch('/auth/v1/user', 'GET', undefined, this.session.access_token);
    if (res.error) return { data: { user: null }, error: res.error };

    return { data: { user: res.data as AuthUser }, error: null };
  }

  /** Update the current user. */
  async updateUser(attributes: {
    email?: string;
    password?: string;
    data?: Record<string, unknown>;
  }): Promise<{ data: { user: AuthUser } | null; error: AuthError | null }> {
    if (!this.session) {
      return { data: null, error: { message: 'Not authenticated', status: 401 } };
    }

    const res = await this.fetch('/auth/v1/user', 'PATCH', attributes, this.session.access_token);
    if (res.error) return { data: null, error: res.error };

    const user = res.data as AuthUser;
    if (this.session) {
      this.session.user = user;
      this.emit('USER_UPDATED', this.session);
    }
    return { data: { user }, error: null };
  }

  /** Refresh the current session. */
  async refreshSession(): Promise<{
    data: { session: AuthSession } | null;
    error: AuthError | null;
  }> {
    if (!this.session?.refresh_token) {
      return { data: null, error: { message: 'No refresh token', status: 401 } };
    }

    const res = await this.fetch('/auth/v1/token', 'POST', {
      grant_type: 'refresh_token',
      refresh_token: this.session.refresh_token,
    });

    if (res.error) {
      this.clearSession();
      return { data: null, error: res.error };
    }

    const session = res.data as AuthSession;
    this.setSession(session, 'TOKEN_REFRESHED');
    return { data: { session }, error: null };
  }

  /** Listen for auth state changes. Returns unsubscribe function. */
  onAuthStateChange(callback: AuthStateChangeCallback): { data: { subscription: { unsubscribe: () => void } } } {
    this.listeners.push(callback);
    // Emit current state immediately
    if (this.session) {
      callback('SIGNED_IN', this.session);
    }
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listeners = this.listeners.filter((l) => l !== callback);
          },
        },
      },
    };
  }

  private setSession(session: AuthSession, event: AuthChangeEvent = 'SIGNED_IN'): void {
    this.session = session;
    this.emit(event, session);
    this.scheduleRefresh();
  }

  private clearSession(): void {
    this.session = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.emit('SIGNED_OUT', null);
  }

  private scheduleRefresh(): void {
    if (!this.autoRefresh || !this.session) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    // Refresh 60 seconds before expiry
    const refreshIn = Math.max((this.session.expires_in - 60) * 1000, 1000);
    this.refreshTimer = setTimeout(() => {
      this.refreshSession();
    }, refreshIn);
  }

  private emit(event: AuthChangeEvent, session: AuthSession | null): void {
    for (const listener of this.listeners) {
      try {
        listener(event, session);
      } catch {
        // swallow
      }
    }
  }

  private async fetch(
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<{ data: unknown; error: AuthError | null }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token || this.anonKey}`,
    };

    const opts: RequestInit = { method, headers };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await globalThis.fetch(`${this.url}${path}`, opts);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!res.ok) {
        const msg = typeof data === 'object' && data !== null && 'error' in data
          ? (data as Record<string, string>).error
          : text;
        return { data: null, error: { message: msg, status: res.status } };
      }

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

export interface AuthError {
  message: string;
  status: number;
}
