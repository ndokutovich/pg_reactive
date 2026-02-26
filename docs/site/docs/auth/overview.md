---
title: Authentication Overview
sidebar_position: 1
description: pgStack authentication system — JWT tokens, argon2id passwords, refresh tokens, OAuth, and RLS integration.
---

# Authentication Overview

pgStack ships a complete authentication system built directly into the proxy. No external auth service required.

## How it works

```
Client                 pgStack Proxy              PostgreSQL
  │                         │                         │
  ├─ POST /auth/v1/signup ──►│                         │
  │                         ├─ argon2id hash password  │
  │                         ├─ INSERT INTO pgstack.users ►│
  │                         ├─ INSERT INTO pgstack.refresh_tokens ►│
  │                         ◄─ { access_token, refresh_token, user } ─┤
  │                         │                         │
  ├─ GET /rest/v1/todos ────►│                         │
  │  Authorization: Bearer  ├─ verify JWT              │
  │                         ├─ SET LOCAL role = 'authenticated' ►│
  │                         ├─ SET LOCAL request.jwt.claims = '...' ►│
  │                         ├─ SELECT * FROM todos ──►│
  │                         │  (RLS policies run here) │
  │                         ◄─ [{ id, title, ... }] ──┤
```

## Token format

pgStack uses **JWT (HS256)** signed with your `JWT_SECRET`.

Access token claims:

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "authenticated",
  "iat": 1700000000,
  "exp": 1700003600
}
```

The `role` claim is the PostgreSQL role that runs your queries. pgStack sets this as the active role before executing REST requests, enabling RLS to work automatically.

## Database schema

Auth data is stored in the `pgstack` schema:

```sql
pgstack.users           -- user accounts
pgstack.refresh_tokens  -- long-lived refresh tokens
pgstack.sessions        -- active sessions (optional tracking)
pgstack.roles           -- role assignments
```

This schema is created by pgStack's own migration when the extension initializes. You should not modify it directly.

## Password security

Passwords are hashed with **argon2id** using memory-hard parameters. Plain-text passwords are never stored or logged.

## Token lifecycle

```
Signup/Login
  └── issues: access_token (1 hour) + refresh_token (30 days)

Access token expires
  └── client calls POST /auth/v1/token { grant_type: "refresh_token", refresh_token }
        └── issues new access_token + rotates refresh_token

Logout
  └── refresh_token invalidated in database
  └── access_token expires naturally (short-lived, not revocable)
```

Token lifetimes are configurable via environment variables:
- `ACCESS_TOKEN_EXPIRY_SECS` — default 3600 (1 hour)
- `REFRESH_TOKEN_EXPIRY_DAYS` — default 30

## Roles

pgStack uses three PostgreSQL roles:

| Role | Description | Who uses it |
|------|-------------|-------------|
| `anon` | Unauthenticated requests | Requests with `ANON_KEY` |
| `authenticated` | Signed-in users | Requests with a valid JWT |
| `service_role` | Admin, bypasses RLS | Requests with `SERVICE_ROLE_KEY` |

Your RLS policies should reference the `authenticated` role:

```sql
-- Only authenticated users can see their own rows
CREATE POLICY "Own rows only"
  ON orders FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND user_id = auth.uid()
  );
```

## Helper functions

pgStack installs these helper functions in the `auth` schema (compatible with Supabase's `auth` helpers):

```sql
-- Current user's UUID (from JWT sub claim)
SELECT auth.uid();

-- Current user's role ('anon', 'authenticated', 'service_role')
SELECT auth.role();

-- Current user's email
SELECT auth.email();
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/v1/signup` | Register a new user |
| `POST` | `/auth/v1/token?grant_type=password` | Sign in with email + password |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | Refresh an access token |
| `GET` | `/auth/v1/user` | Get current user profile |
| `PATCH` | `/auth/v1/user` | Update user profile |
| `POST` | `/auth/v1/logout` | Sign out (invalidate refresh token) |
| `GET` | `/auth/v1/authorize?provider=google` | Start OAuth flow |
| `GET` | `/auth/v1/callback` | OAuth callback (handled by proxy) |

## Next steps

- [Email & Password Auth](./email-password) — signup, login, password reset
- [OAuth](./oauth) — Google and GitHub login
- [Magic Links](./magic-links) — passwordless email login
- [Row Level Security](./rls) — securing your data with RLS
