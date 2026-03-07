---
title: pgStack vs Supabase
sidebar_position: 4
description: Feature comparison between pgStack and Supabase. When to choose each.
---

# pgStack vs Supabase

pgStack is designed as a self-hosted Supabase alternative. This page covers the feature overlap, differences, and migration path.

## Feature comparison

| Feature | Supabase | pgStack |
|---------|----------|---------|
| **Containers** | 15+ (GoTrue, PostgREST, Realtime, Storage, Kong, ...) | **2** (PostgreSQL + Proxy) |
| **Auth provider** | GoTrue (Go service) | Built-in Go proxy |
| **REST API** | PostgREST | pgstack-proxy (Go, PostgREST-compatible) |
| **Real-time** | Phoenix Elixir server | pg_reactive C extension + Go proxy |
| **Row Level Security** | Yes | Yes |
| **Storage** | S3-backed (Supabase Storage) | Built-in (PostgreSQL-backed) |
| **Edge Functions** | Deno runtime | Deno + PL/v8 + Embedded (3 backends) |
| **Transaction Batching** | Not available | Built-in (`POST /rest/v1/batch`) |
| **Studio / Dashboard** | Supabase Studio (React) | pgStack Studio (React) |
| **SDK** | supabase-js | @pgstack/sdk (Supabase-compatible API) |
| **Self-hosting** | Complex (15+ services, Kubernetes recommended) | `docker compose up -d` |
| **Job queues** | Via pg_cron or external | Built-in DBOS (PostgreSQL-backed) |
| **Migrations** | Supabase CLI | pgstack CLI |
| **Type generation** | supabase gen types | pgstack generate types |
| **OAuth** | Google, GitHub, Discord, Twitter, Apple, ... | Google, GitHub |
| **Magic links** | Yes | Yes |
| **Phone auth** | Yes (Twilio) | Not included |
| **Pricing** | Free tier + paid cloud | Open source (self-host free) |
| **PostgreSQL version** | 15 (cloud: managed) | 16 (your own) |

## Where pgStack wins

**Simplicity.** Two containers. One `docker-compose.yml`. Zero cloud dependencies. This makes pgStack vastly easier to understand, debug, and operate — especially for teams without dedicated infrastructure engineers.

**Resource footprint.** Supabase's full self-hosted stack requires 2-4 GB of RAM at idle. pgStack runs comfortably in 512 MB.

**Real-time efficiency.** pg_reactive delivers SQL-level deltas using `EXCEPT`-based diff. You get typed, structured change events — not raw WAL events that require client-side re-querying.

**Transaction batching.** `POST /rest/v1/batch` executes multiple REST operations in a single PostgreSQL transaction with `{{opId.field}}` cross-referencing. Supabase has no equivalent — users have been requesting this since 2015.

**Edge Functions flexibility.** Three runtime backends (Deno, PL/v8, embedded JS) — pick the right tool for the job. Supabase only offers Deno.

**Durable job queues.** The DBOS integration gives you a PostgreSQL-backed job queue with automatic retries, cron scheduling, and observability — no Redis or RabbitMQ.

**Auditability.** With two containers and a single database, your entire system state lives in PostgreSQL. No syncing between microservices.

## Where Supabase wins

**Managed hosting.** Supabase Cloud handles backups, upgrades, and scaling. pgStack is self-hosted only.

**Ecosystem.** Supabase has more OAuth providers and a larger community.

**Realtime presence.** Supabase Realtime supports presence channels and broadcast. pgStack's real-time is focused on live SQL queries.

**Phone auth.** Supabase supports SMS-based auth via Twilio.

## SDK compatibility

The `@pgstack/sdk` is designed to be a drop-in replacement for `@supabase/supabase-js` for the most common patterns:

```typescript
// Supabase
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(url, anonKey);
const { data } = await supabase.from('todos').select('*').eq('done', false);

// pgStack — identical API
import { createClient } from '@pgstack/sdk';
const pgstack = createClient(url, anonKey);
const { data } = await pgstack.from('todos').select('*').eq('done', false);
```

Auth methods match the Supabase JS client:

| Supabase method | pgStack method |
|----------------|----------------|
| `auth.signUp()` | `auth.signUp()` |
| `auth.signInWithPassword()` | `auth.signInWithPassword()` |
| `auth.signInWithOAuth()` | `auth.signInWithOAuth()` |
| `auth.signOut()` | `auth.signOut()` |
| `auth.getUser()` | `auth.getUser()` |
| `auth.getSession()` | `auth.getSession()` |
| `auth.onAuthStateChange()` | `auth.onAuthStateChange()` |

## Migrating from Supabase

1. **Export your schema.** Use `supabase db dump` or `pg_dump` to export your tables, RLS policies, and functions.

2. **Import into pgStack.** Run the dump against your pgStack PostgreSQL instance:
   ```bash
   docker compose exec -T db psql -U postgres -d app < schema.sql
   ```

3. **Update your client URL.** Change the Supabase URL to your pgStack proxy URL in your environment variables.

4. **Update your anon/service keys.** Generate new keys in your `.env` file.

5. **Test auth flows.** The auth API paths are identical (`/auth/v1/signup`, `/auth/v1/token`, etc.).

6. **Test REST queries.** Most PostgREST-compatible queries work without changes.

7. **Migrate storage.** pgStack has built-in storage (PostgreSQL-backed). Upload files via the storage API.
