/**
 * pg_reactive Examples — shared runtime config
 *
 * Auto-detects the base path so examples work when served at any sub-path
 * (e.g. /pg-reactive/ via nginx reverse proxy, or / directly on port 3000).
 *
 * Exposes window.PGR:
 *   PGR.base               — URL base path, e.g. "" or "/pg-reactive"
 *   PGR.wsBase             — WebSocket base, e.g. "wss://host/pg-reactive/ws"
 *   PGR.apiBase            — HTTP API base,  e.g. "https://host/pg-reactive/api"
 *   PGR.anonKey            — Anon API key (transport only; not a credential)
 *   PGR.token              — current session JWT, or null
 *   PGR.signInAnonymously() — async; mints a short-lived role=anon JWT via
 *                             POST /auth/v1/anonymous and stores it in
 *                             sessionStorage. Re-mints automatically when the
 *                             token nears its exp (proactive timer) or when a
 *                             caller awaits it after the token has expired.
 *
 * Discipline (audit round 34): the WS gate refuses raw anon-key in
 * production (REQUIRE_AUTHENTICATED_WS=true). Public-read demo pages
 * must therefore mint a guest JWT — a real signed, expirable token —
 * before opening their WebSocket. The monkey-patch below prefers
 * PGR.token over PGR.anonKey when both are present, so once the page
 * has awaited signInAnonymously() its WS upgrade carries the JWT.
 *
 * Override by setting globals before loading this script:
 *   <script>window.PGR_BASE = '/my-prefix';</script>
 *   <script>window.PGR_ANON_KEY = 'your-anon-key';</script>
 *   <script src="../config.js"></script>
 */
(function () {
  'use strict';

  var base;

  if (typeof window.PGR_BASE === 'string') {
    base = window.PGR_BASE.replace(/\/+$/, '');
  } else if (document.currentScript && document.currentScript.src) {
    var url = new URL(document.currentScript.src);
    base = url.pathname.replace(/\/config\.js$/, '');
  } else {
    var m = location.pathname.match(/^(.*?)\/\d{2}-/);
    base = m ? m[1] : '';
  }

  // The example HTML can be served as a static SUBPATH (e.g. /examples on the
  // pgstack.org apex) of a deployment whose API/WS/auth live at the deployment
  // ROOT — but the auto-detected base above points at the static-examples
  // subpath, so backend calls would hit /examples/auth, /examples/ws, … (404).
  // Strip a trailing /examples segment from an AUTO-DETECTED base so the backend
  // base is the deployment root. An explicit PGR_BASE is honoured verbatim.
  // (Co-located layouts — local web/nginx at root, or /pg-reactive/examples —
  // are handled too: '' stays '', /pg-reactive/examples -> /pg-reactive.)
  if (typeof window.PGR_BASE !== 'string') {
    base = base.replace(/\/examples$/, '');
  }

  var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var anonKey = typeof window.PGR_ANON_KEY === 'string' ? window.PGR_ANON_KEY : 'anon-key-12345';
  var apiBase = location.origin + base + '/api';
  // /auth/ and /rest/ are served directly by the inner nginx without
  // an /api/ prefix (examples/nginx.conf), so build them off origin
  // rather than apiBase. Otherwise POST /api/auth/v1/anonymous would
  // reach the proxy with a literal /api/auth path that doesn't exist.
  var authBase = location.origin + base + '/auth/v1';
  var STORAGE_KEY = 'pgr_guest_token';

  // NOTE: we DELIBERATELY do not surface service_role here. A browser
  // page must never need the service-role key — it bypasses RLS and
  // grants admin access. Examples that look like they need it (e.g.
  // catalog refresh) should call an authenticated endpoint server-side
  // instead, or use Studio (which prompts for the key once per session).

  var tokenPromise = null;
  var refreshTimer = null;

  function loadCachedToken() {
    try { return sessionStorage.getItem(STORAGE_KEY) || null; } catch (e) { return null; }
  }

  function saveCachedToken(token) {
    try { sessionStorage.setItem(STORAGE_KEY, token); } catch (e) { /* private mode */ }
  }

  function clearCachedToken() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* private mode */ }
  }

  // Decode the JWT payload (middle segment) and check its exp claim. A
  // 60-second skew gives us a margin for token-mint latency vs WS open,
  // so a token doesn't expire mid-handshake. Anything we cannot parse is
  // treated as expired — fail-closed forces a fresh mint.
  function tokenStillValid(token) {
    try {
      var parts = token.split('.');
      if (parts.length !== 3) return false;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(atob(b64));
      if (!payload.exp) return false;
      return payload.exp > (Date.now() / 1000) + 60;
    } catch (e) {
      return false;
    }
  }

  // The anon endpoint issues NO refresh token (proxy-go/auth/anonymous.go):
  // the client must re-mint when the access token expires. Schedule a
  // proactive re-mint ~60s before exp so PGR.token is always fresh for the
  // next WS reconnect or REST call. Background tabs throttle timers, so
  // callers that can await (REST, the WS reconnect path) still go through
  // signInAnonymously(), which re-mints on demand if the timer was starved.
  function scheduleRefresh(token) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try {
      var parts = token.split('.');
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(atob(b64));
      if (!payload.exp) return;
      var ms = (payload.exp - 60) * 1000 - Date.now();
      if (ms < 5000) ms = 5000;
      refreshTimer = setTimeout(function () {
        tokenPromise = null;       // force a fresh mint
        clearCachedToken();
        signInAnonymously().catch(function () {});
      }, ms);
    } catch (e) { /* unparseable — leave on-demand refresh to recover */ }
  }

  function mintToken() {
    return fetch(authBase + '/anonymous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': anonKey },
      body: '{}'
    }).then(function (res) {
      if (res.status === 503) {
        // Server has ALLOW_ANONYMOUS_SIGNIN=false. Public examples will
        // fall back to anon-key on the WS (still works if the proxy is
        // configured to allow anon WS — i.e. NOT REQUIRE_AUTHENTICATED_WS).
        return null;
      }
      if (!res.ok) throw new Error('anonymous signin failed: ' + res.status);
      return res.json().then(function (session) { return session.access_token; });
    }).then(function (token) {
      if (token) {
        window.PGR.token = token;
        saveCachedToken(token);
        scheduleRefresh(token);
      }
      return token;
    }).catch(function (err) {
      tokenPromise = null;     // allow retry
      console.warn('signInAnonymously failed:', err);
      throw err;
    });
  }

  function signInAnonymously() {
    // Reuse an in-flight/resolved mint only while its token is still valid;
    // a stale memoized promise is what caused the 401-after-an-hour bug.
    if (tokenPromise) {
      return tokenPromise.then(function (tok) {
        if (tok && tokenStillValid(tok)) return tok;
        tokenPromise = null;     // expired — drop and re-mint
        clearCachedToken();
        window.PGR.token = null;
        return signInAnonymously();
      });
    }
    var cached = loadCachedToken();
    if (cached && tokenStillValid(cached)) {
      window.PGR.token = cached;
      scheduleRefresh(cached);
      tokenPromise = Promise.resolve(cached);
      return tokenPromise;
    }
    if (cached) {
      // Expired or unparseable — drop it before minting a fresh one so
      // a botched mint doesn't leave the stale token lingering for the
      // next page load.
      clearCachedToken();
      window.PGR.token = null;
    }
    tokenPromise = mintToken();
    return tokenPromise;
  }

  window.PGR = {
    base:    base,
    wsBase:  wsProto + location.host + base + '/ws',
    apiBase: apiBase,
    anonKey: anonKey,
    token:   (function () { var t = loadCachedToken(); return t && tokenStillValid(t) ? t : null; })(),
    signInAnonymously: signInAnonymously,
  };

  // Auto-inject auth on WebSocket connections targeting /ws/. Browsers
  // cannot set custom headers on WS handshakes, so the credential must
  // ride as a query parameter. We prefer a real signed JWT (PGR.token,
  // populated by signInAnonymously) over the raw anon-key — that's the
  // pattern REQUIRE_AUTHENTICATED_WS=true demands.
  var _WS = WebSocket;
  window.WebSocket = function (url, protocols) {
    if (url.indexOf('/ws/') !== -1 && url.indexOf('apikey=') === -1 && url.indexOf('token=') === -1) {
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      if (window.PGR.token) {
        url += sep + 'token=' + encodeURIComponent(window.PGR.token);
      } else if (anonKey) {
        url += sep + 'apikey=' + encodeURIComponent(anonKey);
      }
    }
    return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;
})();
