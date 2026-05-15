---
title: Row Level Security
sidebar_position: 5
description: Secure your PostgreSQL tables with Row Level Security (RLS) and pgStack JWT claims.
---

# Row Level Security (RLS)

Row Level Security (RLS) is PostgreSQL's built-in mechanism for controlling which rows a user can read, insert, update, or delete. pgStack enforces RLS on every REST API request by running queries as the authenticated user's role.

## How pgStack enforces RLS

When a REST request arrives with a JWT, the proxy:

1. Verifies the JWT signature using `JWT_SECRET`
2. Sets the PostgreSQL role to the JWT's `role` claim (`anon` or `authenticated`)
3. Sets `request.jwt.claims` to the full JWT payload as a JSON string
4. Executes your query within this role context
5. PostgreSQL evaluates your RLS policies before returning results

```sql
-- These are set by the proxy before your query runs:
SET LOCAL ROLE = 'authenticated';
SET LOCAL request.jwt.claims = '{"sub":"user-uuid","email":"user@example.com","role":"authenticated"}';
```

Because the query runs as `authenticated` (not `postgres` or `service_role`), PostgreSQL's RLS policies apply automatically.

## Enabling RLS

Always enable RLS before writing policies. A table with RLS enabled but no policies denies all access by default.

```sql
-- Enable RLS on a table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
```

## Realtime: audience-bound subscriptions

RLS handles row-level security for REST queries. For **live queries** (WebSocket subscriptions), pgStack adds a parallel mechanism — the `audience` parameter on `pgr.subscribe`. Where RLS scopes a query's *rows* to the caller, audience scopes the entire *subscription* to a JWT claim predicate.

```sql
-- Server-side, at player login:
SELECT pgr.subscribe(
  'inv_' || player_id::text,
  format('SELECT name, count FROM player_inventory WHERE player_id = %L',
         player_id),
  'delta',
  jsonb_build_object('sub', player_id::text));
```

Now even if another client learns the channel name `inv_42`, their JWT (`sub=99`) cannot satisfy the audience `{"sub":"42"}` — the proxy returns `403` at WS-connect. This is the "deep fix" for capability leakage on live queries; combine with RLS on the underlying tables for defence in depth (the snapshot is filtered by WHERE at subscribe time, but RLS still applies if `service_role` is not in use). See [Subscribing to Queries](/docs/realtime/subscribe#audience-bound-subscriptions-since-012) for full semantics.

## Granting access to your tables

Since the 2026-05 security audit, pgStack does NOT grant `anon` or `authenticated` blanket access to new tables in `public`. Every application table must declare its grants explicitly — preferably alongside enabling RLS:

```sql
-- Create the table
CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id uuid NOT NULL,
  total numeric(10,2) NOT NULL
);

-- Grant the role privileges your RLS policies will further restrict.
-- Without these GRANTs, RLS policies never get a chance to run — anon and
-- authenticated hit "permission denied for table orders" first.
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO authenticated;

-- Now enable RLS and write policies.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_orders ON orders
  FOR ALL TO authenticated
  USING (customer_id = auth.uid())
  WITH CHECK (customer_id = auth.uid());
```

`service_role` is unaffected — proxy internals (catalog refresh, batch operations, migrations) keep blanket access. If you want anon read access, grant `SELECT` explicitly and write a permissive policy.

The strict default replaces the old `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon` + `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated` plus `ALTER DEFAULT PRIVILEGES` chain. That was a footgun: every `CREATE TABLE` in a migration silently exposed the table through REST until RLS was added. Upgrading installs run `migrations/20260515200000_revoke_blanket_grants.sql` once to drop the legacy grants.

## Helper functions

pgStack installs these helper functions for use in RLS policies:

```sql
-- Current user's UUID (from JWT sub claim)
auth.uid()      -- returns UUID or NULL

-- Current role ('anon', 'authenticated', 'service_role')
auth.role()     -- returns TEXT

-- Current user's email
auth.email()    -- returns TEXT or NULL

-- Full JWT claims as JSONB
auth.jwt()      -- returns JSONB (empty object if no JWT)
```

These are shorthand for reading `request.jwt.claims`:

```sql
-- Equivalent to auth.uid():
(current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid

-- Access custom claims via auth.jwt():
(auth.jwt()->>'org_id')::uuid
```

## Policy examples

### Users see only their own rows

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own orders"
  ON orders FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own orders"
  ON orders FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own orders"
  ON orders FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users delete own orders"
  ON orders FOR DELETE
  USING (user_id = auth.uid());
```

### Public read, authenticated write

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- Anyone (even unauthenticated) can read posts
CREATE POLICY "Public read"
  ON posts FOR SELECT
  USING (true);

-- Only authenticated users can create posts
CREATE POLICY "Authenticated insert"
  ON posts FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Authors can edit their own posts
CREATE POLICY "Author update"
  ON posts FOR UPDATE
  USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());
```

### Team-based access (multi-tenant)

```sql
-- Users belong to teams via team_members table
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members see team projects"
  ON projects FOR SELECT
  USING (
    team_id IN (
      SELECT team_id FROM team_members
      WHERE user_id = auth.uid()
    )
  );
```

### Admin bypass

Requests made with `SERVICE_ROLE_KEY` run as the `service_role` role. Create a bypass policy, or disable RLS checks for service_role:

```sql
-- Option 1: Explicit bypass policy
CREATE POLICY "Service role bypass"
  ON orders FOR ALL
  USING (auth.role() = 'service_role');

-- Option 2: BYPASSRLS (applied at role level, not table level)
-- pgStack's service_role has BYPASSRLS by default
```

### JSON metadata in policies

You can access any JWT claim in your policies using `auth.jwt()`:

```sql
-- Using a custom claim 'org_id' in the JWT
CREATE POLICY "Org isolation"
  ON documents FOR ALL
  USING (org_id = (auth.jwt()->>'org_id')::uuid);
```

To add custom claims, include extra fields when generating your JWTs.

## Testing RLS policies

Use `SET ROLE` in psql to test policies as a specific user:

```sql
-- Test as anonymous user
SET ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT * FROM orders; -- should return 0 rows (or public rows only)

-- Test as authenticated user
SET ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"550e8400-e29b-41d4-a716-446655440000","role":"authenticated"}';
SELECT * FROM orders; -- should return only that user's orders

-- Reset
RESET ROLE;
```

## Common mistakes

**Forgetting WITH CHECK on INSERT/UPDATE.** `USING` applies to rows being read. `WITH CHECK` applies to rows being written. For `INSERT` and `UPDATE`, you usually need both.

```sql
-- Wrong: INSERT policy without WITH CHECK
CREATE POLICY "Bad insert" ON orders FOR INSERT USING (user_id = auth.uid());

-- Correct
CREATE POLICY "Good insert" ON orders FOR INSERT WITH CHECK (user_id = auth.uid());
```

**Infinite recursion.** Policies that query a table protected by a policy on the same table can cause infinite recursion. Use `SECURITY DEFINER` functions as a workaround:

```sql
-- Safe: helper function bypasses RLS for the membership check
CREATE OR REPLACE FUNCTION is_team_member(p_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS(
    SELECT 1 FROM team_members
    WHERE team_id = p_team_id AND user_id = auth.uid()
  );
$$;

CREATE POLICY "Team access" ON projects FOR SELECT
  USING (is_team_member(team_id));
```

**Not enabling RLS.** RLS policies are only evaluated when RLS is enabled on the table. A table without `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` allows all access.

## Disabling RLS for a table

For tables that should be fully public (e.g., a read-only products catalog):

```sql
-- Option 1: Don't enable RLS
-- All roles can read (anon, authenticated, service_role)

-- Option 2: Enable RLS with an open policy
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON products FOR SELECT USING (true);
-- Only SELECT is allowed; INSERT/UPDATE/DELETE require explicit policies
```
