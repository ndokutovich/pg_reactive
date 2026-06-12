---
title: Security Model
sidebar_position: 7
description: How to expose live queries safely — why pgr.subscribe is a privileged API and the canonical SECURITY DEFINER wrapper pattern for app clients.
---

# Security Model

This is the page to read before you let any application client register a live
query. `pgr.subscribe` is a **privileged admin API**, not a per-tenant grant.
Get this wrong and you have handed an attacker a `SECURITY DEFINER`-context
remote code execution primitive. Get it right — with a thin wrapper — and you
can safely expose live queries to authenticated browsers.

The short version:

- **Never** `GRANT EXECUTE ON FUNCTION pgr.subscribe(...) TO` an application role.
- Expose subscription registration to clients **only** through a purpose-built
  `SECURITY DEFINER` wrapper with a fixed query template, server-derived
  `query_id` and `audience`, a pinned `search_path`, and fully-qualified
  object references.
- Use the `audience` argument to bind a subscription to a JWT claim so the
  proxy refuses to serve its deltas to anyone else.

## Why pgr.subscribe is privileged

The SQL text you pass to `pgr.subscribe(query_id, sql, ...)` is stored verbatim
and later **re-executed by the extension's trigger path** on every relevant DML.
That trigger path runs as `SECURITY DEFINER` — as the extension owner, typically
`postgres` or `pgstack_admin` — so anything the caller can put into the query
string runs with elevated privileges. (See [Architecture](./architecture.md)
for how the AFTER STATEMENT triggers and recompute path work.)

A role that holds `EXECUTE` on `pgr.subscribe` **and** also has `CREATE` on any
schema in its `search_path` (most `authenticated` roles have `CREATE` on
`public`) can escalate to definer-context code execution in three steps:

1. `CREATE FUNCTION attacker_payload() RETURNS int LANGUAGE plpgsql AS $$ ... $$`
   under its own privileges, then
2. subscribe a query like `SELECT attacker_payload() FROM pg_namespace LIMIT 1`,
3. and the extension's `SECURITY DEFINER` trigger path evaluates that query on
   every matching DML — running the attacker's function as the extension owner.

This is a privilege boundary, not a usage convenience.

### The default: revoked from PUBLIC

The pgStack bootstrap (`docker/init.sql`) default-denies execution: `pgr.subscribe`
and `pgr.unsubscribe` are `REVOKE`d from `PUBLIC`. If you install the extension
standalone, the same discipline applies — keep both functions available only to
your admin role.

In the [trust matrix](#trust-model-recap), the `pgr.subscribe` (registration) row
is `DENY` for both `anon` and `authenticated`, and `ALLOW` only for `service_role`.
App callers reach it exclusively through wrappers.

### The footgun — do NOT do this

```sql
-- ❌ Grants every app user the ability to register arbitrary SQL that
--    later runs SECURITY DEFINER. Combined with CREATE FUNCTION (which
--    most authenticated roles have on the public schema) this is a
--    DEFINER-context RCE.
GRANT EXECUTE ON FUNCTION pgr.subscribe(text, text, text, jsonb) TO myapp_role;
GRANT EXECUTE ON FUNCTION pgr.unsubscribe(text) TO myapp_role;
```

## The canonical safe pattern

Keep `pgr.subscribe` / `pgr.unsubscribe` available only to your admin role
(typically `postgres` / `service_role`). Expose subscription registration to
application clients through a purpose-built `SECURITY DEFINER` wrapper.

Every such wrapper MUST have all five of these properties. Drop any one and you
reopen a hole:

1. **Fixed query template** — the SQL text is a literal string the caller cannot
   influence. Only typed arguments flow in, and only where they belong (a `WHERE`
   value, never the query shape).
2. **Server-derived `query_id` and `audience`** — both come from `auth.uid()` /
   the verified JWT, never from a client-supplied string. A caller must not be
   able to name someone else's stream.
3. **`SET search_path = pg_catalog, pg_temp`** — no `public`. Without this pin, a
   role with `CREATE` on `public` can shadow `format()`, `auth.uid()`, or even
   `pgr.subscribe` itself and run its own code in the definer's context.
4. **Fully-qualified object references** — `public.todos`, `pgr.subscribe`,
   `auth.uid`. The pinned `search_path` doesn't include `public`, so an
   unqualified reference would fail at runtime; qualifying everything is both
   correct and the safe default.
5. **An explicit `GRANT EXECUTE TO {role}`** — the bootstrap default-denies
   `PUBLIC EXECUTE` on `public.*` functions, so without this grant RPC callers
   get "permission denied for function". Grant the *wrapper* to `authenticated`;
   `pgr.subscribe` itself stays revoked.

### Working example — the todo app wrapper

This is the wrapper that ships with the todo example
(`examples/apps/todo/setup.sql`). The table has standard RLS policies keyed on
`auth.uid()`; the wrapper is the only path through which a client registers a
live query over it.

```sql
-- Table with per-user RLS (abbreviated — see the full setup.sql).
CREATE TABLE IF NOT EXISTS todos (
  id          serial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  text        text NOT NULL,
  priority    int  NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 2),
  done        boolean NOT NULL DEFAULT false,
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY todos_own_select ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY todos_own_insert ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY todos_own_update ON todos FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY todos_own_delete ON todos FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO authenticated;

-- The subscription wrapper. SECURITY DEFINER + pinned search_path
-- (pg_catalog + pg_temp only); every app object fully qualified
-- (public.todos, pgr.subscribe, auth.uid).
CREATE OR REPLACE FUNCTION public.subscribe_my_todos()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_qid text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;
  v_qid := 'todos_' || v_uid::text;
  PERFORM pgr.subscribe(
    v_qid,
    format('SELECT id, text, priority, done, due_at, created_at
            FROM public.todos WHERE user_id = %L
            ORDER BY done ASC, priority DESC, created_at DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );
  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_todos() TO authenticated;
```

Walking the five properties through this function:

- **Fixed template** — the `SELECT ... FROM public.todos` string is a constant.
  The only caller-derived value is `v_uid`, interpolated via `format(... %L ...)`
  as a literal into the `WHERE` clause. The client cannot change the columns,
  the table, or the predicate shape.
- **Server-derived identity** — `v_uid` comes from `auth.uid()` (the verified JWT
  `sub`), not from a function argument. `v_qid` is `'todos_' || v_uid`, so each
  user always lands on their own `query_id` and can never name another user's.
- **Pinned path** — `SET search_path = pg_catalog, pg_temp` means a hostile
  `public.format` or `public.auth` cannot hijack the body.
- **Qualified refs** — `public.todos`, `pgr.subscribe`, and `auth.uid` are all
  schema-qualified, so they resolve under the pinned path.
- **Explicit grant** — `GRANT EXECUTE ON FUNCTION public.subscribe_my_todos() TO
  authenticated`. `pgr.subscribe` stays revoked from `authenticated`.

### Wrapper with an explicit argument

If your wrapper takes the user id as an argument instead of reading
`auth.uid()` directly, **the wrapper itself is the gate** — it must verify the
argument against the verified JWT before delegating. This is the canonical shape
from the spec (`docs/specs/pg_reactive_spec.md` §9.4):

```sql
CREATE FUNCTION public.subscribe_my_orders(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp  -- ⚠ NO public; closes the search-path attack
AS $$
DECLARE
  qid text := 'orders_' || p_user::text;
BEGIN
  -- AuthZ check the wrapper enforces. Callers only ever reach pgr.subscribe
  -- via this function, so the JWT-sub match below is what binds a
  -- subscription to its owner.
  IF p_user IS DISTINCT FROM
       (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid THEN
    RAISE EXCEPTION 'forbidden: caller may only subscribe to own orders';
  END IF;
  RETURN pgr.subscribe(
    qid,
    format('SELECT id, status, total FROM public.orders WHERE user_id = %L', p_user),
    'delta',                                  -- delivery mode (delta | notify)
    jsonb_build_object('sub', p_user::text)   -- audience binding
  );
END $$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_orders(uuid) TO authenticated;
-- pgr.subscribe itself stays revoked from authenticated.
```

Note `'delta'` here is the **delivery mode** (delta = ship inserted/deleted rows;
notify = ship a bare invalidation signal — see [Wire Format](./wire-format.md)).
It is not a role, and the wrapper does not switch identity per call.

### If you cannot use a wrapper

For truly admin-only tooling, grant `pgr.subscribe` only to a dedicated admin
role — and **never** to a role that also holds `CREATE` on any schema on its
`search_path`. That `CREATE` privilege is the second half of the exploit; remove
either half and the escalation closes.

## Audience-bound subscriptions

The fourth argument to `pgr.subscribe` is `audience` — a JSON object enforced by
the proxy at WebSocket connect time. It is your defense-in-depth against a client
subscribing to a `query_id` it shouldn't see.

```sql
-- Public (legacy) behaviour: any client may read.
SELECT pgr.subscribe('online_count', 'SELECT count(*) FROM presence');

-- Bound to one user — only a JWT with sub=42 may open this stream.
SELECT pgr.subscribe(
  'inv_42',
  'SELECT name, count FROM player_inventory WHERE player_id = ''42''',
  'delta',
  '{"sub":"42"}'::jsonb);

-- Multi-key: the connecting JWT must satisfy ALL keys.
SELECT pgr.subscribe(
  'admin_audit',
  'SELECT * FROM audit_log',
  'delta',
  '{"role":"admin","org":"acme"}'::jsonb);
```

How the gate works:

- Every key in the audience object must **match the corresponding JWT claim** on
  the connecting client. Any mismatch and the proxy rejects the WebSocket with
  `403 Forbidden`.
- `service_role` JWTs always bypass the audience gate.
- A `NULL` audience preserves the pre-binding public behaviour — any authenticated
  client may connect.
- The proxy reads the audience from the transactional `pgr.subscription_meta()`
  — over the MVCC catalog, never the non-transactional `pgr.get_subscriptions()`
  shmem view — on **every** WS connect, again right before the initial snapshot,
  and on **every** delivered delta. A connection whose claims no longer satisfy
  the current audience is disconnected, so a re-registration cannot leak to an
  already-open socket (round 37/39).

The audience is stored in shared memory with a **512-byte** serialised cap, so
keep it to the claims you actually gate on.

Why bind audience in the wrapper? In `subscribe_my_todos` the wrapper sets
`jsonb_build_object('sub', v_uid::text)`. That means even if some other client
learned the `query_id` `todos_<uuid>`, the proxy would refuse to serve that
stream's deltas unless the connecting JWT's `sub` equals that uuid. The wrapper
binds the audience; the proxy enforces it. See [Proxy](./proxy.md) for the
WebSocket auth flow.

## How this fits RLS

Audience binding gates **who the proxy serves a stream to**. It is not a
replacement for Row-Level Security on the underlying table. Defense in depth uses
both:

- **RLS** on the table (`todos_own_select` etc.) bounds what rows the query can
  ever return, and protects the same data on the REST path.
- **Audience** on the subscription bounds who the proxy will open the WebSocket
  for.

Keep your live-query SQL inside the same trust envelope as your RLS policies —
the wrapper's fixed template (`WHERE user_id = %L`) should mirror the policy's
`USING (user_id = auth.uid())`. For the platform's RLS model on the REST side,
see [RLS](/auth/rls).

## SECURITY DEFINER hardening checklist

Any `SECURITY DEFINER` function you add — wrapper or otherwise — must satisfy all
of the following. These are project invariants, lint-enforced where greppable:

| Requirement | Why |
|---|---|
| `SET search_path = pg_catalog, pg_temp` | Without it, a role with `CREATE` on `public` can shadow `auth.uid`, `format`, or `pgr.subscribe` and run code as the definer. |
| Fully-qualify every object reference | The pinned path excludes `public`; an unqualified ref fails at runtime and is a search-path risk besides. |
| Explicit `GRANT EXECUTE TO {role}` | The bootstrap default-denies `PUBLIC EXECUTE`; without the grant, RPC callers get "permission denied for function". |
| `REVOKE EXECUTE ... FROM PUBLIC` (extension install path) | PostgreSQL grants `PUBLIC EXECUTE` on new functions by default; a `SECURITY DEFINER` function left un-revoked runs as the owner for *any* caller. |
| Fixed query template, server-derived identity | A caller-controlled SQL string in a definer function is RCE. |

## Trust model recap

The project's full trust boundary lives in
[`SECURITY.md`](https://github.com/ndokutovich/pg_reactive/blob/master/SECURITY.md)
— the role list, the capability × role matrix, and the cross-cutting invariants.
The rows that bear directly on live queries:

| Capability | anon | authenticated | service_role | Enforcement |
|---|---|---|---|---|
| `pgr.subscribe` (registration) | DENY | DENY | ALLOW | Revoked from PUBLIC; app callers go through `SECURITY DEFINER` wrappers with fixed SQL. |
| WebSocket: open `/ws/{queryId}` | COND | ALLOW | ALLOW | `REQUIRE_AUTHENTICATED_WS=true` refuses anon; audience binding scopes deltas. |

If you operate the bundled pgStack umbrella, the proxy refuses to start in
`PGSTACK_ENV=production` without `JWT_SECRET` (≥32 chars), real `ANON_KEY` /
`SERVICE_ROLE_KEY`, and `REQUIRE_AUTHENTICATED_WS=true`, among others. See
[Environment Variables](/deploy/env-vars) for the full production checklist.

## Where to go next

- [Subscribe](./subscribe.md) — the `pgr.subscribe` / `pgr.unsubscribe` API in full.
- [Proxy](./proxy.md) — how the Go proxy authenticates WebSocket clients and enforces audience.
- [Wire Format](./wire-format.md) — delta / overflow / invalidated message shapes.
- [SDK](./sdk.md) — passing the JWT from a client.
- [Quickstart](/quickstart) — standing up the full pgStack umbrella.
