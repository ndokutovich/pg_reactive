import { get } from 'svelte/store';
import { accessToken } from './stores.js';

const m = location.pathname.match(/^(.*?)\/apps\//);
const base = m ? m[1] : '';
export const API_BASE = location.origin + base;
export const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;
export const ANON_KEY = 'anon-key-12345';

export function parseJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '=='.slice(0, (4 - b64.length % 4) % 4)));
  } catch (e) {
    return null;
  }
}

function authHeaders() {
  const token = get(accessToken);
  const h = { 'Content-Type': 'application/json', 'apikey': ANON_KEY };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

const SESSION_KEY = 'wtb-session';

export function saveSession(data) {
  const session = { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function tryRefresh() {
  const session = loadSession();
  if (!session || !session.refresh_token) return Promise.resolve(null);
  return fetch(API_BASE + '/auth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
  }).then(r => r.json()).then(data => {
    if (!data.access_token) { clearSession(); return null; }
    saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user || session.user });
    return data;
  }).catch(() => { clearSession(); return null; });
}

export function apiSql(sql) {
  return fetch(API_BASE + '/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql })
  }).then(r => r.json());
}

export function apiRest(method, path, body) {
  function doFetch() {
    const opts = { method, headers: authHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API_BASE + '/rest/v1/' + path, opts).then(res => {
      if (res.status === 204) return null;
      if (res.status === 401) {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      return res.json().then(data => {
        if (!res.ok) {
          const err = new Error(data.error || data.message || JSON.stringify(data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }
  return doFetch().catch(err => {
    if (err.status === 401) {
      return tryRefresh().then(session => {
        if (!session) throw err;
        accessToken.set(session.access_token);
        return doFetch();
      });
    }
    throw err;
  });
}

export function apiRpc(fn, params) {
  function doFetch() {
    return fetch(API_BASE + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(params || {})
    }).then(res => {
      if (res.status === 401) {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      return res.json().then(data => {
        if (!res.ok) {
          const err = new Error(data.error || data.message || JSON.stringify(data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }
  return doFetch().catch(err => {
    if (err.status === 401) {
      return tryRefresh().then(session => {
        if (!session) throw err;
        accessToken.set(session.access_token);
        return doFetch();
      });
    }
    throw err;
  });
}
