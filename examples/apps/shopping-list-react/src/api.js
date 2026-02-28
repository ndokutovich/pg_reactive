const m = location.pathname.match(/^(.*?)\/apps\//);
const base = m ? m[1] : '';
export const API_BASE = location.origin + base;
export const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;

export const ANON_KEY = 'anon-key-12345';
export const POLL_INTERVAL = 2000;

const SESSION_KEY = 'wtb-session';

export function saveSession(data) {
  const session = { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function tryRefresh() {
  const session = loadSession();
  if (!session || !session.refresh_token) return Promise.resolve(null);
  return fetch(API_BASE + '/auth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
  }).then(r => r.json()).then(data => {
    if (!data.access_token) { clearSession(); return null; }
    saveSession(data);
    return data;
  }).catch(() => { clearSession(); return null; });
}

export function parseJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '=='.slice(0, (4 - b64.length % 4) % 4)));
  } catch {
    return null;
  }
}

export function authHeaders(accessToken) {
  const h = { 'Content-Type': 'application/json', apikey: ANON_KEY };
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken;
  return h;
}

export function apiSql(sql) {
  return fetch(API_BASE + '/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  }).then((r) => r.json());
}

export function apiRest(method, path, body, accessToken) {
  function doFetch(token) {
    const opts = { method, headers: authHeaders(token) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API_BASE + '/rest/v1/' + path, opts).then((res) => {
      if (res.status === 204) return null;
      return res.json().then((data) => {
        if (!res.ok) {
          const err = new Error(data.error || data.message || JSON.stringify(data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }
  return doFetch(accessToken).catch(err => {
    if (err.status === 401) {
      return tryRefresh().then(session => {
        if (!session) throw err;
        return doFetch(session.access_token);
      });
    }
    throw err;
  });
}

export function apiRpc(fn, params, accessToken) {
  function doFetch(token) {
    return fetch(API_BASE + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(params || {}),
    }).then((res) =>
      res.json().then((data) => {
        if (!res.ok) {
          const err = new Error(data.error || data.message || JSON.stringify(data));
          err.status = res.status;
          throw err;
        }
        return data;
      })
    );
  }
  return doFetch(accessToken).catch(err => {
    if (err.status === 401) {
      return tryRefresh().then(session => {
        if (!session) throw err;
        return doFetch(session.access_token);
      });
    }
    throw err;
  });
}
