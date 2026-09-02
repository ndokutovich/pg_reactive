---
sidebar_position: 4
title: Upgrading to 0.3.0
---

# Upgrading to 0.3.0 — anonymous identity

0.3.0 changes the trust model **only if you run `ALLOW_ANONYMOUS_SIGNIN=true`**.
Everyone else: run the SQL migration during a normal upgrade and you are done —
the new role is inert until guests exist.

## What changed

Guests from `POST /auth/v1/anonymous` used to be a fiction: a `role=anon` JWT
with no database row and no refresh token. Now a guest is a **real account**:

- a row in `pgstack.users` (`provider='anonymous'`, synthetic RFC 2606
  `.invalid` address, `email_confirmed_at` NULL),
- a refresh token — guests survive closing the tab,
- the JWT carries `is_anonymous: true`, and the PG role is **`anonymous`** — a
  new, fourth principal: `anon ⊆ anonymous ⊂ authenticated`,
- an upgrade path: a guest that attaches email+password keeps its id (and all
  its `auth.uid()`-keyed rows) and becomes a full member.

`TO authenticated` policies therefore **stop matching guests** — deliberately.
A policy written before guests existed keeps meaning what it meant.

## Steps

1. **Run the migration** (idempotent, safe to re-run) before deploying the
   0.3.0 proxy — the proxy refuses to boot in production against a database
   that lacks the `anonymous` role:

   ```bash
   psql "$ADMIN_DSN" -f migrations/20260902120000_anonymous_role.sql
   ```

2. **Pick your guest semantics** (only matters with anonymous sign-in on):

   - **Strict (default, recommended)** — keep `ANONYMOUS_ROLE=anonymous` and
     audit your policies: for each `TO authenticated` policy/GRANT where
     guests belong, change to `TO authenticated, anonymous`. Anything keyed
     on `auth.uid()` needs no other change.
   - **Supabase-compatible** — set `ANONYMOUS_ROLE=authenticated`. Guests
     sign in exactly as before-0.3.0-Supabase would: `role=authenticated`
     plus the `is_anonymous` claim. Zero policy changes; guard sensitive
     policies with
     `COALESCE((auth.jwt()->>'is_anonymous')::boolean, false) = false`
     at your own pace.

3. **Mirror the visitor floor.** Everything you grant `TO anon` should also
   be granted `TO anonymous` (a guest can do whatever a logged-out visitor
   can). The shipped fixtures and examples already carry this.

4. **Optional: enable the guest reaper** — `ANONYMOUS_ACCOUNT_TTL_DAYS=30`
   deletes never-upgraded guests with no live refresh token. Check your FK
   `ON DELETE` behaviour first; upgraded accounts are never touched.

## Client-visible changes

| | before | 0.3.0 |
|---|---|---|
| `signInAnonymously()` response | no `refresh_token` | refresh token present; session persists |
| JWT `role` | `anon` | `anonymous` (or `authenticated` in compat mode) |
| JWT claims | — | `is_anonymous: true` |
| `GET /auth/v1/user` as guest | 404 (no row) | 200 (own row) |
| `REQUIRE_AUTHENTICATED_WS` | guests passed | guests still pass |

## Rollback

Redeploy a pre-0.3.0 proxy. The `anonymous` role is inert without a proxy
that mints it; do **not** drop the role while 0.3.0-issued JWTs are still
live.
