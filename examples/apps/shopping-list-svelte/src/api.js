import { get } from 'svelte/store';
import { accessToken } from './stores.js';

export const API_BASE = window.location.origin;
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

export function apiSql(sql) {
  return fetch(API_BASE + '/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql })
  }).then(r => r.json());
}

export function apiRest(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(API_BASE + '/rest/v1/' + path, opts).then(res => {
    if (res.status === 204) return null;
    return res.json().then(data => {
      if (!res.ok) throw new Error(data.error || data.message || JSON.stringify(data));
      return data;
    });
  });
}

export function apiRpc(fn, params) {
  return fetch(API_BASE + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(params || {})
  }).then(res => {
    return res.json().then(data => {
      if (!res.ok) throw new Error(data.error || data.message || JSON.stringify(data));
      return data;
    });
  });
}
