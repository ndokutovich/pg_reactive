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
 *
 * Override by setting window.PGR_BASE before loading this script:
 *   <script>window.PGR_BASE = '/my-prefix';</script>
 *   <script src="../config.js"></script>
 */
(function () {
  'use strict';

  var base;

  if (typeof window.PGR_BASE === 'string') {
    // Explicit override — strip trailing slash
    base = window.PGR_BASE.replace(/\/+$/, '');
  } else {
    // Auto-detect: examples live at {base}/NN-name/app.html
    // Extract everything before the /NN- segment
    var m = location.pathname.match(/^(.*?)\/\d{2}-/);
    base = m ? m[1] : '';
  }

  var wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  window.PGR = {
    base:    base,
    wsBase:  wsProto + location.host + base + '/ws',
    apiBase: location.origin + base + '/api',
  };
})();
