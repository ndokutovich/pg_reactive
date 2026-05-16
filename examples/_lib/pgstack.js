/**
 * pgStack browser SDK helper (vanilla JS, no build step).
 *
 * One class encapsulating the four pgStack capabilities used by examples:
 *
 *   - Auth         : auto-signup with persisted creds; signin via stored token
 *   - LiveQuery    : open /ws/{query_id} with the user's JWT (audience-aware)
 *   - Channel      : /ws/_channel_<name> with typed broadcast envelope
 *   - REST/Function: fetch wrappers that thread apikey + Bearer correctly
 *
 * Designed to demonstrate best practices (since the 2026-05 audit):
 *   - query_id for per-user data is NEVER constructed client-side. The server
 *     derives it from auth.uid() inside a SECURITY DEFINER function and binds
 *     an audience predicate. The client just calls a function (e.g.
 *     `subscribe_inventory()`) and uses whatever query_id it returns.
 *   - Anon-key vs JWT is explicit: pass `{anon: true}` only when you really
 *     want public data.
 *   - WebSocket frame types are filtered: server-deltas (no `type`,
 *     `{inserted,deleted}`) vs broadcast envelope (`type:"broadcast",from`)
 *     vs presence (`type:"presence_*"`).
 *
 * Depends on the global `window.PGR` exposed by ../config.js — auto-detects
 * base path so examples work at any URL prefix.
 */
(function (global) {
  'use strict';

  class PgStack {
    constructor(opts = {}) {
      const cfg = global.PGR || {};
      this.apiBase = opts.apiBase || cfg.apiBase || (location.origin + '/api');
      this.restBase = (this.apiBase || '').replace(/\/api$/, '') + '/rest/v1';
      this.fnBase = (this.apiBase || '').replace(/\/api$/, '') + '/functions/v1';
      this.authBase = (this.apiBase || '').replace(/\/api$/, '') + '/auth/v1';
      this.wsBase = opts.wsBase || cfg.wsBase ||
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      this.anonKey = opts.anonKey || cfg.anonKey || '';
      this.storageKey = opts.storageKey || 'pgr_session';
      this.token = null;
      this.user = null;
    }

    // ─── Auth ────────────────────────────────────────────────────────────

    /** Restore session from sessionStorage if present. Returns user or null. */
    restoreSession() {
      try {
        const raw = sessionStorage.getItem(this.storageKey);
        if (!raw) return null;
        const session = JSON.parse(raw);
        if (!session.access_token || !session.user) return null;
        this.token = session.access_token;
        this.user = session.user;
        return this.user;
      } catch { return null; }
    }

    _saveSession(session) {
      this.token = session.access_token;
      this.user = session.user;
      try { sessionStorage.setItem(this.storageKey, JSON.stringify(session)); }
      catch { /* private mode etc — non-fatal */ }
    }

    _clearSession() {
      this.token = null;
      this.user = null;
      try { sessionStorage.removeItem(this.storageKey); } catch {}
    }

    /**
     * Auto-signup with generated credentials. Persists the random email +
     * password so the same browser keeps the same identity across reloads.
     * This is the "guest account" pattern — fine for examples, real apps
     * should offer a proper signup UI.
     */
    async autoAuth(displayName) {
      const restored = this.restoreSession();
      if (restored) {
        // Try refresh-free reuse first; if the JWT is expired the next
        // authed call will surface 401 and the caller decides what to do.
        return this.user;
      }

      const stored = this._loadCreds();
      if (stored) {
        try {
          const session = await this.signIn(stored.email, stored.password);
          return session.user;
        } catch { /* fall through to signup */ }
      }

      const uuid = crypto.randomUUID();
      const email = `${uuid}@example.invalid`;
      const password = crypto.randomUUID();
      const session = await this.signUp(email, password, displayName ? { display_name: displayName } : null);
      this._saveCreds({ email, password });
      return session.user;
    }

    _loadCreds() {
      try {
        const raw = sessionStorage.getItem(this.storageKey + '_creds');
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
    _saveCreds(c) {
      try { sessionStorage.setItem(this.storageKey + '_creds', JSON.stringify(c)); } catch {}
    }

    async signUp(email, password, data) {
      const body = { email, password };
      if (data) body.data = data;
      const res = await fetch(`${this.authBase}/signup`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(body)
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error || 'signup failed');
      this._saveSession(session);
      return session;
    }

    async signIn(email, password) {
      const res = await fetch(`${this.authBase}/token`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify({ grant_type: 'password', email, password })
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error || 'login failed');
      this._saveSession(session);
      return session;
    }

    signOut() { this._clearSession(); }

    _authHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (this.anonKey) h['apikey'] = this.anonKey;
      if (this.token) h['Authorization'] = `Bearer ${this.token}`;
      return h;
    }

    // ─── REST ────────────────────────────────────────────────────────────

    async rest(path, init = {}) {
      const res = await fetch(`${this.restBase}${path}`, {
        ...init,
        headers: { ...this._authHeaders(), ...(init.headers || {}) }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || res.statusText);
      }
      return res.status === 204 ? null : res.json();
    }

    // ─── Edge functions ──────────────────────────────────────────────────

    async invoke(name, body) {
      const res = await fetch(`${this.fnBase}/${name}`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: body == null ? '{}' : JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `function ${name} failed`);
      return data;
    }

    // ─── LiveQuery ───────────────────────────────────────────────────────

    /**
     * Open a live-query WebSocket for the given query_id.
     *
     * @param {string} queryId Server-issued id. Do NOT construct user-
     *   scoped ids client-side: call a server function that returns the
     *   bound id (audience-protected).
     * @param {object} handlers
     *   - onSnapshot(rows)          first batch when delta-mode subscription has seed data
     *   - onDelta(inserted, deleted) every subsequent change
     *   - onInvalidate()            notify-mode signal
     *   - onOpen() / onClose() / onError(err)
     * @param {object} opts
     *   - anon: true              use anon key instead of JWT (public queries)
     * @returns {{close: () => void}} disposer
     */
    liveQuery(queryId, handlers = {}, opts = {}) {
      const useToken = !opts.anon && this.token;
      let url = `${this.wsBase}/${encodeURIComponent(queryId)}`;
      const qp = [];
      if (useToken) qp.push('token=' + encodeURIComponent(this.token));
      else if (this.anonKey) qp.push('apikey=' + encodeURIComponent(this.anonKey));
      if (qp.length) url += '?' + qp.join('&');

      const ws = new WebSocket(url);
      let firstDelta = true;

      ws.addEventListener('open', () => handlers.onOpen && handlers.onOpen());
      ws.addEventListener('close', () => handlers.onClose && handlers.onClose());
      ws.addEventListener('error', (e) => handlers.onError && handlers.onError(e));

      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'subscribed') return;
        if (msg.type === 'overflow') return handlers.onOverflow && handlers.onOverflow(msg);
        if (msg.type === 'invalidated') return handlers.onInvalidate && handlers.onInvalidate();
        if (msg.type === 'presence_state' || msg.type === 'presence_join' ||
            msg.type === 'presence_leave' || msg.type === 'presence_update') return;
        if (msg.type === 'broadcast') return; // peer message — use channel() for that
        if (msg.type) return;                   // unknown typed message

        // Typeless message with inserted/deleted = server delta.
        const inserted = msg.inserted || [];
        const deleted = msg.deleted || [];
        if (firstDelta && handlers.onSnapshot) {
          firstDelta = false;
          handlers.onSnapshot(inserted);
        } else if (handlers.onDelta) {
          handlers.onDelta(inserted, deleted);
        }
      });

      return { close: () => { try { ws.close(); } catch {} } };
    }

    // ─── Channel (peer-to-peer broadcast + presence) ─────────────────────

    /**
     * Open a presence + broadcast channel. Channel name is a normal
     * query_id; you typically use audience binding for private channels
     * (e.g. `room_<roomId>` with audience `{"room":"<id>"}`) and a
     * server-side helper to register it.
     */
    channel(name, handlers = {}) {
      const useToken = !!this.token;
      let url = `${this.wsBase}/${encodeURIComponent(name)}`;
      const qp = [];
      if (useToken) qp.push('token=' + encodeURIComponent(this.token));
      else if (this.anonKey) qp.push('apikey=' + encodeURIComponent(this.anonKey));
      if (qp.length) url += '?' + qp.join('&');

      const ws = new WebSocket(url);

      ws.addEventListener('open', () => handlers.onOpen && handlers.onOpen());
      ws.addEventListener('close', () => handlers.onClose && handlers.onClose());

      ws.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        switch (msg.type) {
          case 'subscribed': return;
          case 'presence_state':
          case 'presence_join':
          case 'presence_leave':
          case 'presence_update':
            return handlers.onPresence && handlers.onPresence(msg);
          case 'broadcast':
            return handlers.onBroadcast && handlers.onBroadcast(msg.payload, msg.from);
          default: return;
        }
      });

      return {
        send(payload)   { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'broadcast', payload })); },
        presence(state) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', state })); },
        close()         { try { ws.close(); } catch {} }
      };
    }
  }

  global.PgStack = PgStack;
})(window);
