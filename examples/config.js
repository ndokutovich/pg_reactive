/**
 * pg_reactive Examples — shared runtime config
 *
 * Auto-detects the base path so examples work when served at any sub-path
 * (e.g. /pg-reactive/ via nginx reverse proxy, or / directly on port 3000).
 *
 * Exposes window.PGR:
 *   PGR.base    — URL base path, e.g. "" or "/pg-reactive"
 *   PGR.wsBase  — WebSocket base, e.g. "wss://host/pg-reactive/ws"
 *   PGR.apiBase — HTTP API base,  e.g. "https://host/pg-reactive/api"
 *   PGR.anonKey — Anon API key for unauthenticated access (null if auth disabled)
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
    // Explicit override — strip trailing slash
    base = window.PGR_BASE.replace(/\/+$/, '');
  } else if (document.currentScript && document.currentScript.src) {
    // Detect base from config.js script URL — works at any sub-path.
    // config.js is always at {base}/config.js, so strip the filename.
    var url = new URL(document.currentScript.src);
    base = url.pathname.replace(/\/config\.js$/, '');
  } else {
    // Fallback: numbered example paths like {base}/01-name/app.html
    var m = location.pathname.match(/^(.*?)\/\d{2}-/);
    base = m ? m[1] : '';
  }

  var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  var anonKey = typeof window.PGR_ANON_KEY === 'string' ? window.PGR_ANON_KEY : 'anon-key-12345';
  var serviceRoleKey = typeof window.PGR_SERVICE_ROLE_KEY === 'string'
    ? window.PGR_SERVICE_ROLE_KEY
    : 'dev-only-service-role-key-do-not-use-in-production';

  window.PGR = {
    base:    base,
    wsBase:  wsProto + location.host + base + '/ws',
    apiBase: location.origin + base + '/api',
    anonKey: anonKey,
    serviceRoleKey: serviceRoleKey,
  };

  // Auto-inject ?apikey= into WebSocket connections targeting /ws/.
  // Browsers cannot set custom headers on WebSocket handshakes, so the
  // anon key must be passed as a query parameter. This monkey-patch means
  // zero changes are required in individual example HTML files.
  if (anonKey) {
    var _WS = WebSocket;
    window.WebSocket = function (url, protocols) {
      if (url.indexOf('/ws/') !== -1 && url.indexOf('apikey=') === -1) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'apikey=' + encodeURIComponent(anonKey);
      }
      return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
    };
    window.WebSocket.prototype = _WS.prototype;
    window.WebSocket.CONNECTING = _WS.CONNECTING;
    window.WebSocket.OPEN = _WS.OPEN;
    window.WebSocket.CLOSING = _WS.CLOSING;
    window.WebSocket.CLOSED = _WS.CLOSED;
  }
})();
