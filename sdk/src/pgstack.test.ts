import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgStackClient, createClient } from './pgstack.js';

// ---- Mock fetch ----

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(status: number, body: unknown, statusText = 'OK') {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ---- PgStackClient ----

describe('PgStackClient', () => {
  it('creates client with createClient factory', () => {
    const client = createClient('http://127.0.0.1:8080', 'anon-key');
    expect(client).toBeInstanceOf(PgStackClient);
    expect(client.url).toBe('http://127.0.0.1:8080');
  });

  it('strips trailing slashes from URL', () => {
    const client = createClient('http://127.0.0.1:8080///', 'key');
    expect(client.url).toBe('http://127.0.0.1:8080');
  });

  it('provides auth instance', () => {
    const client = createClient('http://127.0.0.1:8080', 'key');
    expect(client.auth.constructor.name).toBe('PgStackAuth');
  });

  it('from() returns a PgStackQueryBuilder', () => {
    const client = createClient('http://127.0.0.1:8080', 'key');
    const builder = client.from('todos');
    expect(builder.constructor.name).toBe('PgStackQueryBuilder');
  });

  describe('rpc()', () => {
    it('calls RPC via POST with params', async () => {
      fetchMock.mockReturnValue(mockResponse(200, 8));
      const client = createClient('http://127.0.0.1:8080', 'anon-key');

      const { data, error } = await client.rpc('add_numbers', { a: 5, b: 3 });

      expect(error).toBeNull();
      expect(data).toBe(8);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8080/rest/v1/rpc/add_numbers');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ a: 5, b: 3 });
    });

    it('calls RPC via GET with params in query string', async () => {
      fetchMock.mockReturnValue(mockResponse(200, 'Hello!'));
      const client = createClient('http://127.0.0.1:8080', 'key');

      const { data } = await client.rpc('greet', { name: 'World' }, { get: true });

      expect(data).toBe('Hello!');
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('?name=World');
      expect(opts.method).toBe('GET');
    });

    it('returns error on non-ok response', async () => {
      fetchMock.mockReturnValue(mockResponse(404, { error: 'Function not found' }, 'Not Found'));
      const client = createClient('http://127.0.0.1:8080', 'key');

      const { data, error } = await client.rpc('nonexistent');

      expect(data).toBeNull();
      expect(error).toEqual({ message: 'Function not found', status: 404 });
    });

    it('handles network errors', async () => {
      fetchMock.mockRejectedValue(new Error('Connection refused'));
      const client = createClient('http://127.0.0.1:8080', 'key');

      const { data, error } = await client.rpc('anything');

      expect(data).toBeNull();
      expect(error!.message).toBe('Connection refused');
      expect(error!.status).toBe(0);
    });
  });

  it('uses anon key in Authorization header by default', async () => {
    fetchMock.mockReturnValue(mockResponse(200, []));
    const client = createClient('http://127.0.0.1:8080', 'my-anon-key');

    await client.from('todos').select('*');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer my-anon-key');
  });
});

// ---- PgStackQueryBuilder ----

describe('PgStackQueryBuilder', () => {
  let client: PgStackClient;

  beforeEach(() => {
    client = createClient('http://127.0.0.1:8080', 'key');
  });

  it('builds SELECT with filters', async () => {
    fetchMock.mockReturnValue(mockResponse(200, [{ id: 1 }]));

    const { data } = await client.from('todos').select('*').eq('done', 'false');

    expect(data).toEqual([{ id: 1 }]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('select=*');
    expect(url).toContain('done=eq.false');
  });

  it('builds SELECT with order and limit', async () => {
    fetchMock.mockReturnValue(mockResponse(200, [{ id: 2 }, { id: 1 }]));

    await client.from('todos').select('id').order('id', { ascending: false }).limit(2);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('order=id.desc');
    expect(url).toContain('limit=2');
  });

  it('single() unwraps array to object', async () => {
    fetchMock.mockReturnValue(mockResponse(200, [{ id: 1, title: 'Hello' }]));

    const { data } = await client.from('todos').select('*').eq('id', 1).single();

    expect(data).toEqual({ id: 1, title: 'Hello' });
    expect(Array.isArray(data)).toBe(false);
  });

  it('single() returns null for empty array', async () => {
    fetchMock.mockReturnValue(mockResponse(200, []));

    const { data } = await client.from('todos').select('*').eq('id', 999).single();

    expect(data).toBeNull();
  });

  it('insert() sends POST', async () => {
    fetchMock.mockReturnValue(mockResponse(201, [{ id: 1, title: 'New' }]));

    const { data, status } = await client.from('todos').insert({ title: 'New' });

    expect(status).toBe(201);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ title: 'New' });
  });

  it('update() sends PATCH with filters', async () => {
    fetchMock.mockReturnValue(mockResponse(200, [{ id: 1, done: true }]));

    const { data } = await client.from('todos').eq('id', 1).update({ done: true });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('PATCH');
    expect(url).toContain('id=eq.1');
  });

  it('delete() sends DELETE with filters', async () => {
    fetchMock.mockReturnValue(mockResponse(200, [{ id: 1 }]));

    await client.from('todos').eq('id', 1).delete();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    expect(url).toContain('id=eq.1');
  });

  it('handles all filter operators', async () => {
    fetchMock.mockReturnValue(mockResponse(200, []));

    await client.from('t')
      .select('*')
      .neq('a', 1)
      .gt('b', 2)
      .gte('c', 3)
      .lt('d', 4)
      .lte('e', 5)
      .like('f', '%test%')
      .ilike('g', '%Test%')
      .is('h', null)
      .in('i', [1, 2, 3]);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('a=neq.1');
    expect(url).toContain('b=gt.2');
    expect(url).toContain('c=gte.3');
    expect(url).toContain('d=lt.4');
    expect(url).toContain('e=lte.5');
    expect(url).toContain('f=like.%25test%25');
    expect(url).toContain('g=ilike.%25Test%25');
    expect(url).toContain('h=is.null');
    expect(url).toContain('i=in.(1,2,3)');
  });

  it('range() sets offset and limit', async () => {
    fetchMock.mockReturnValue(mockResponse(200, []));

    await client.from('todos').select('*').range(10, 19);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=10');
  });

  it('returns error on non-ok response', async () => {
    fetchMock.mockReturnValue(mockResponse(403, { error: 'Forbidden' }, 'Forbidden'));

    const { data, error, status } = await client.from('secret_table').select('*');

    expect(data).toBeNull();
    expect(error).toEqual({ message: 'Forbidden', status: 403 });
    expect(status).toBe(403);
  });

  it('returns network error gracefully', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const { data, error, status } = await client.from('todos').select('*');

    expect(data).toBeNull();
    expect(error!.message).toBe('ECONNREFUSED');
    expect(status).toBe(0);
  });
});

// ---- PgStackAuth ----

describe('PgStackAuth', () => {
  it('signUp sends correct request', async () => {
    fetchMock.mockReturnValue(mockResponse(200, {
      access_token: 'tok-123',
      refresh_token: 'ref-456',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'u1', email: 'a@b.com', role: 'authenticated', user_metadata: {}, created_at: '', updated_at: '' },
    }));

    const client = createClient('http://127.0.0.1:8080', 'key');
    const { data, error } = await client.auth.signUp({
      email: 'a@b.com',
      password: 'pass',
      options: { data: { name: 'Alice' } },
    });

    expect(error).toBeNull();
    expect(data!.user.email).toBe('a@b.com');
    expect(data!.session.access_token).toBe('tok-123');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/auth/v1/signup');
    const body = JSON.parse(opts.body);
    expect(body.email).toBe('a@b.com');
    expect(body.data).toEqual({ name: 'Alice' });
  });

  it('signInWithPassword sends grant_type password', async () => {
    fetchMock.mockReturnValue(mockResponse(200, {
      access_token: 'tok',
      refresh_token: 'ref',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'u1', email: 'a@b.com', role: 'authenticated', user_metadata: {}, created_at: '', updated_at: '' },
    }));

    const client = createClient('http://127.0.0.1:8080', 'key');
    await client.auth.signInWithPassword({ email: 'a@b.com', password: 'pass' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/auth/v1/token');
    const body = JSON.parse(opts.body);
    expect(body.grant_type).toBe('password');
  });

  it('signOut clears session', async () => {
    // First sign in
    fetchMock.mockReturnValue(mockResponse(200, {
      access_token: 'tok',
      refresh_token: 'ref',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'u1', email: 'a@b.com', role: 'authenticated', user_metadata: {}, created_at: '', updated_at: '' },
    }));

    const client = createClient('http://127.0.0.1:8080', 'key');
    await client.auth.signInWithPassword({ email: 'a@b.com', password: 'pass' });

    // Then sign out
    fetchMock.mockReturnValue(mockResponse(204, ''));
    const { error } = await client.auth.signOut();

    expect(error).toBeNull();

    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
  });

  it('auth state changes update Authorization header', async () => {
    fetchMock.mockReturnValueOnce(mockResponse(200, {
      access_token: 'user-token-123',
      refresh_token: 'ref',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'u1', email: 'a@b.com', role: 'authenticated', user_metadata: {}, created_at: '', updated_at: '' },
    }));

    const client = createClient('http://127.0.0.1:8080', 'anon-key');
    await client.auth.signInWithPassword({ email: 'a@b.com', password: 'pass' });

    // Now make a data request — should use the user token
    fetchMock.mockReturnValueOnce(mockResponse(200, []));
    await client.from('todos').select('*');

    const [, opts] = fetchMock.mock.calls[1];
    expect(opts.headers['Authorization']).toBe('Bearer user-token-123');
  });

  it('onAuthStateChange fires on sign in and sign out', async () => {
    const events: string[] = [];

    const client = createClient('http://127.0.0.1:8080', 'key');
    client.auth.onAuthStateChange((event) => {
      events.push(event);
    });

    // Sign in
    fetchMock.mockReturnValueOnce(mockResponse(200, {
      access_token: 'tok',
      refresh_token: 'ref',
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'u1', email: 'a@b.com', role: 'authenticated', user_metadata: {}, created_at: '', updated_at: '' },
    }));
    await client.auth.signInWithPassword({ email: 'a@b.com', password: 'pass' });

    expect(events).toContain('SIGNED_IN');

    // Sign out
    fetchMock.mockReturnValueOnce(mockResponse(204, ''));
    await client.auth.signOut();

    expect(events).toContain('SIGNED_OUT');
  });

  it('signUp returns error on failure', async () => {
    fetchMock.mockReturnValue(mockResponse(400, { error: 'Email already exists' }, 'Bad Request'));

    const client = createClient('http://127.0.0.1:8080', 'key');
    const { data, error } = await client.auth.signUp({
      email: 'dup@test.com',
      password: 'pass',
    });

    expect(data).toBeNull();
    expect(error!.message).toBe('Email already exists');
    expect(error!.status).toBe(400);
  });
});
