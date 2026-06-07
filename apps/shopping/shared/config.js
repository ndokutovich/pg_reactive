/* What to Buy — shared runtime config */
(function() {
  'use strict';
  var m = location.pathname.match(/^(.*?)\/apps\//);
  var base = m ? m[1] : '';
  var ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;

  // Server-side subscribe_list_items() registers query ids as
  //   items-<list_id>-<sub_uuid_no_dashes>
  // and binds an audience predicate {sub: <uid>} so only the owner of
  // the JWT can connect. The frontend must derive the same suffix from
  // its own JWT — otherwise the WS upgrade falls through to a 404 and
  // the page silently degrades to polling.
  function subClaim(jwt) {
    try {
      var p = jwt.split('.');
      if (p.length !== 3) return '';
      var b = p[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      var claims = JSON.parse(atob(b));
      return (claims && claims.sub) || '';
    } catch (e) { return ''; }
  }
  function itemsQueryId(listId, jwt) {
    var sub = subClaim(jwt).replace(/-/g, '');
    return sub ? ('items-' + listId + '-' + sub) : ('items-' + listId);
  }

  window.WTB = {
    apiBase:        location.origin + base,
    wsBase:         ws,
    anonKey:        'anon-key-12345',
    itemsQueryId:   itemsQueryId,
    subClaim:       subClaim
  };
})();
