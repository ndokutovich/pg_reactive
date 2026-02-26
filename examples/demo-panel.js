/**
 * pg_reactive Demo Panel
 *
 * Drop-in toolbar for example pages. Set window.DEMO_ACTIONS before loading:
 *
 *   window.DEMO_ACTIONS = [
 *     { action: 'insert_product', label: 'Add Product' },
 *     { action: 'update_price',   label: 'Update Price' },
 *   ];
 */
(function () {
  'use strict';

  var API = (window.PGR ? PGR.apiBase : location.origin + '/api') + '/demo';
  var actions = window.DEMO_ACTIONS || [];
  if (!actions.length) return;

  // ── Build toolbar DOM ──
  var bar = document.createElement('div');
  bar.id = 'demo-panel';
  bar.style.cssText = [
    'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:9999',
    'background:#161b22', 'border-top:1px solid #30363d',
    'padding:12px 24px', 'display:flex', 'align-items:center',
    'gap:10px', 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
    'font-size:13px',
  ].join(';');

  var label = document.createElement('span');
  label.textContent = 'Demo';
  label.style.cssText = 'color:#8b949e;font-weight:600;margin-right:6px;text-transform:uppercase;letter-spacing:0.05em;font-size:11px';
  bar.appendChild(label);

  actions.forEach(function (cfg) {
    var btn = document.createElement('button');
    btn.textContent = cfg.label;
    btn.setAttribute('data-action', cfg.action);
    btn.style.cssText = [
      'background:#21262d', 'color:#c9d1d9', 'border:1px solid #30363d',
      'border-radius:6px', 'padding:6px 14px', 'cursor:pointer',
      'font-size:13px', 'font-family:inherit', 'transition:all 0.15s',
    ].join(';');
    btn.onmouseenter = function () { btn.style.background = '#30363d'; btn.style.borderColor = '#58a6ff'; };
    btn.onmouseleave = function () { btn.style.background = '#21262d'; btn.style.borderColor = '#30363d'; };
    btn.onclick = function () { fireAction(cfg.action, btn); };
    bar.appendChild(btn);
  });

  // Status indicator
  var status = document.createElement('span');
  status.style.cssText = 'color:#8b949e;margin-left:auto;font-size:12px;transition:opacity 0.3s';
  bar.appendChild(status);

  document.body.appendChild(bar);

  // Add bottom padding so toolbar doesn't overlap content
  document.body.style.paddingBottom = '60px';

  // ── API call ──
  function fireAction(action, btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    status.textContent = '';

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          flash(btn, '#39d353'); // green
          status.textContent = action + ' \u2714';
          status.style.color = '#39d353';
        } else {
          flash(btn, '#f85149'); // red
          status.textContent = data.error || 'error';
          status.style.color = '#f85149';
        }
      })
      .catch(function (err) {
        flash(btn, '#f85149');
        status.textContent = 'network error';
        status.style.color = '#f85149';
      })
      .finally(function () {
        btn.disabled = false;
        btn.style.opacity = '1';
        setTimeout(function () { status.textContent = ''; }, 3000);
      });
  }

  function flash(el, color) {
    el.style.borderColor = color;
    el.style.boxShadow = '0 0 6px ' + color;
    setTimeout(function () {
      el.style.borderColor = '#30363d';
      el.style.boxShadow = 'none';
    }, 600);
  }
})();
