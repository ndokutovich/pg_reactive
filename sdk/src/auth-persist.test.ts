import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgStackAuth, type AuthSession } from './auth-client.js';

// Contract: the auth client persists real sessions (those with a refresh
// token) into an injectable storage so a page reload / new tab restores the
// login without another OAuth redirect. Anonymous JWTs (no refresh token by
// design) are never persisted. Default storage is globalThis.localStorage
// when present; every storage access is failure-tolerant.

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => (m.has(k) ? m.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => void m.set(k, v)),
    removeItem: vi.fn((k: string) => void m.delete(k)),
    _map: m,
  };
}

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: 'u-1',
      email: 'p@x',
      role: 'authenticated',
      user_metadata: {},
      created_at: '',
      updated_at: '',
    },
    ...over,
  };
}

const KEY = 'pgstack.auth.token';

describe('session persistence', () => {
  it('persists a session with a refresh token on sign-in', async () => {
    const storage = memStorage();
    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    fetchMock.mockReturnValue(mockResponse(200, session()));

    await auth.signInWithPassword({ email: 'p@x', password: 'pw' });

    expect(storage.setItem).toHaveBeenCalled();
    const stored = JSON.parse(storage._map.get(KEY)!);
    expect(stored.session.refresh_token).toBe('rt-1');
    expect(typeof stored.expires_at).toBe('number');
  });

  it('does NOT persist an anonymous session (no refresh token)', async () => {
    const storage = memStorage();
    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    fetchMock.mockReturnValue(
      mockResponse(200, session({ refresh_token: '', user: { ...session().user, is_anonymous: true } })),
    );

    await auth.signInAnonymously();

    expect(storage._map.has(KEY)).toBe(false);
  });

  it('restores a fresh stored session without network', async () => {
    const storage = memStorage();
    storage._map.set(
      KEY,
      JSON.stringify({ session: session(), expires_at: Date.now() + 3000 * 1000 }),
    );

    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    const { data } = await auth.getSession(); // must await restore internally

    expect(data.session?.access_token).toBe('at-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired stored session on load and persists the rotation', async () => {
    const storage = memStorage();
    storage._map.set(
      KEY,
      JSON.stringify({ session: session(), expires_at: Date.now() - 1000 }),
    );
    const rotated = session({ access_token: 'at-2', refresh_token: 'rt-2' });
    fetchMock.mockReturnValue(mockResponse(200, rotated));

    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    const { data } = await auth.getSession();

    expect(data.session?.access_token).toBe('at-2');
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('/auth/v1/token');
    expect(JSON.parse((call[1] as RequestInit).body as string).grant_type).toBe('refresh_token');
    expect(JSON.parse(storage._map.get(KEY)!).session.refresh_token).toBe('rt-2');
  });

  it('clears storage when the stored refresh token is rejected', async () => {
    const storage = memStorage();
    storage._map.set(
      KEY,
      JSON.stringify({ session: session(), expires_at: Date.now() - 1000 }),
    );
    fetchMock.mockReturnValue(mockResponse(401, { error: 'invalid refresh token' }));

    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    const { data } = await auth.getSession();

    expect(data.session).toBeNull();
    expect(storage._map.has(KEY)).toBe(false);
  });

  it('signOut removes the persisted session', async () => {
    const storage = memStorage();
    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    fetchMock.mockReturnValue(mockResponse(200, session()));
    await auth.signInWithPassword({ email: 'p@x', password: 'pw' });
    expect(storage._map.has(KEY)).toBe(true);

    fetchMock.mockReturnValue(mockResponse(200, {}));
    await auth.signOut();

    expect(storage._map.has(KEY)).toBe(false);
  });

  it('persistSession:false disables all storage traffic', async () => {
    const storage = memStorage();
    const auth = new PgStackAuth('http://x', 'anon', {
      storage,
      persistSession: false,
      detectSessionInUrl: false,
    });
    fetchMock.mockReturnValue(mockResponse(200, session()));

    await auth.signInWithPassword({ email: 'p@x', password: 'pw' });

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('a throwing storage never breaks auth', async () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('quota');
      }),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn(() => {
        throw new Error('quota');
      }),
    };
    const auth = new PgStackAuth('http://x', 'anon', { storage, detectSessionInUrl: false });
    fetchMock.mockReturnValue(mockResponse(200, session()));

    const { data, error } = await auth.signInWithPassword({ email: 'p@x', password: 'pw' });

    expect(error).toBeNull();
    expect(data?.session.access_token).toBe('at-1');
  });
});
