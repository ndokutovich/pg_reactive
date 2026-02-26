export const API_BASE = window.location.origin
export const ANON_KEY = 'anon-key-12345'
export const POLL_INTERVAL = 2000

export function parseJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64 + '=='.slice(0, (4 - b64.length % 4) % 4)))
  } catch (e) {
    return null
  }
}

export function authHeaders(accessToken) {
  const h = { 'Content-Type': 'application/json', 'apikey': ANON_KEY }
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken
  return h
}

export function apiSql(sql) {
  return fetch(API_BASE + '/api/sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql })
  }).then(r => r.json())
}

export function apiRest(method, path, body, accessToken) {
  const opts = { method, headers: authHeaders(accessToken) }
  if (body !== undefined) opts.body = JSON.stringify(body)
  return fetch(API_BASE + '/rest/v1/' + path, opts).then(res => {
    if (res.status === 204) return null
    return res.json().then(data => {
      if (!res.ok) throw new Error(data.error || data.message || JSON.stringify(data))
      return data
    })
  })
}

export function apiRpc(fn, params, accessToken) {
  return fetch(API_BASE + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(params || {})
  }).then(res => {
    return res.json().then(data => {
      if (!res.ok) throw new Error(data.error || data.message || JSON.stringify(data))
      return data
    })
  })
}
