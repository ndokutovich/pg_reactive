/* What to Buy — shared runtime config */
(function() {
  'use strict';
  var m = location.pathname.match(/^(.*?)\/apps\//);
  var base = m ? m[1] : '';
  var ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;
  window.WTB = {
    apiBase: location.origin + base,
    wsBase:  ws,
    anonKey: 'anon-key-12345'
  };
})();
