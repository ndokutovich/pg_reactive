# pgStack vs Supabase — Full Compatibility Matrix

> Generated 2026-03-20. Live-tested against running pgStack instance.

## REST API (PostgREST)

| Feature | Supabase | pgStack | Status |
|---------|:---:|:---:|:---:|
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | ✅ | ✅ | Live verified |
| `like`, `ilike` | ✅ | ✅ | Live verified |
| `is` (null check) | ✅ | ✅ | Live verified |
| `in` (value list) | ✅ | ✅ | Live verified |
| `not.` prefix | ✅ | ✅ | Live verified |
| `fts` (full-text search) | ✅ | ✅ | Live verified |
| `cs` (contains @>) | ✅ | ✅ | Live verified (array columns) |
| `cd` (contained by) | ✅ | ✅ | Implemented |
| `or()` combinator | ✅ | ✅ | Live verified |
| `and()` combinator | ✅ | ✅ | Live verified |
| `ov` (overlap) | ✅ | ✅ | Implemented |
| `sl`/`sr` (range) | ✅ | ✅ | Implemented |
| `adj` (adjacent) | ✅ | ✅ | Implemented |
| `nxl`/`nxr` (does not extend) | ✅ | ✅ | Implemented |
| `plfts`/`phfts`/`wfts` | ✅ | ❌ | Not implemented |
| `?select=col1,col2` | ✅ | ✅ | Live verified |
| `?order=col.asc` | ✅ | ✅ | Live verified |
| `?limit=N&offset=N` | ✅ | ✅ | Live verified |
| FK embedding | ✅ | ✅ | E2E: 55 tests |
| INSERT (POST) | ✅ | ✅ | Live verified (201) |
| UPDATE (PATCH) | ✅ | ✅ | Live verified |
| DELETE | ✅ | ✅ | Live verified |
| Upsert (POST + Prefer) | ✅ | ❌ | SDK sends `Prefer: resolution=merge-duplicates` but proxy ignores it (no `ON CONFLICT`); duplicates raise unique-violation |
| Bulk INSERT (array) | ✅ | ✅ | E2E test |
| RPC (POST /rpc/fn) | ✅ | ✅ | Live verified |
| RPC (GET /rpc/fn) | ✅ | ✅ | E2E test |
| `Content-Range` header | ✅ | ✅ | Live verified (`0-0/2`) |
| `Prefer: count=exact` | ✅ | ✅ | Live verified |
| `Prefer: count=planned` | ✅ | ✅ | Implemented |
| `Prefer: return=minimal` | ✅ | ✅ | Implemented |
| Batch transactions | ❌ | ✅ | Extra feature (33 E2E tests) |

## Auth (GoTrue)

| Feature | Supabase | pgStack | Status |
|---------|:---:|:---:|:---:|
| POST /auth/v1/signup | ✅ | ✅ | Live verified (201) |
| POST /auth/v1/token (password) | ✅ | ✅ | E2E: 37 tests |
| POST /auth/v1/token (refresh) | ✅ | ✅ | E2E (reuse detection) |
| GET /auth/v1/user | ✅ | ✅ | E2E test |
| PATCH /auth/v1/user | ✅ | ✅ | E2E test |
| POST /auth/v1/logout | ✅ | ✅ | E2E test |
| POST /auth/v1/recover | ✅ | ✅ | Live verified |
| POST /auth/v1/magiclink | ✅ | ✅ | Live verified |
| GET /auth/v1/verify | ✅ | ✅ | E2E test |
| OAuth (Google, PKCE) | ✅ | ✅ | Live verified (302 redirect) |
| OAuth (GitHub) | ✅ | ✅ | Implemented |
| OAuth (Apple, form_post) | ✅ | ✅ | Implemented |
| OAuth (Microsoft) | ✅ | ✅ | Implemented |
| Generic OIDC provider | ⚠️ | ✅ | `OIDC_{CLIENT_ID,CLIENT_SECRET,ISSUER_URL}` |
| Admin CRUD users | ✅ | ✅ | Live verified |
| Refresh token families | ✅ | ✅ | E2E test |
| Email verification | ✅ | ✅ | Implemented |
| Anonymous sign-in | ✅ | ⚠️ | POST /auth/v1/anonymous (`ALLOW_ANONYMOUS_SIGNIN`); ephemeral JWT, no user row / refresh token |
| SMS auth | ✅ | ❌ | Not planned |
| Phone field | ✅ | ❌ | Not planned |
| SAML/SSO | ✅ Enterprise | ❌ | Not planned |

## Realtime

| Feature | Supabase | pgStack | Notes |
|---------|:---:|:---:|-------|
| WebSocket connection | ✅ | ✅ | Different protocol |
| Table change notifications | ✅ `postgres_changes` | ✅ `pgr.subscribe()` | **Different model** |
| Query-level deltas (EXCEPT diff) | ❌ | ✅ | pgStack-only |
| GROUP BY / aggregate subscriptions | ❌ | ✅ | pgStack-only |
| Window functions | ❌ | ✅ | pgStack-only |
| Multi-table JOIN subscriptions | ❌ | ✅ | pgStack-only |
| Column-level tracking | ❌ | ✅ | pgStack-only |
| Presence | ✅ | ✅ | `_presence_` channels over WS + `GET /ws/_presence/{channel}` |
| Broadcast channels | ✅ | ⚠️ | Custom channels only |
| Notify (lightweight) mode | ❌ | ✅ | pgStack-only |
| Database webhooks | ✅ | ✅ | `/rest/v1/webhooks`, HMAC-SHA256 `X-Webhook-Signature` delivery |

## Storage

| Feature | Supabase | pgStack | Status |
|---------|:---:|:---:|:---:|
| Upload/download | ✅ | ✅ | Implemented |
| List objects | ✅ | ✅ | Implemented |
| Signed URLs | ✅ | ❌ | Not implemented (`getPublicUrl` for public buckets only) |
| Buckets (public/private) | ✅ | ✅ | Implemented |
| RLS on objects | ✅ | ✅ | init.sql policies |
| Image transforms | ✅ | ❌ | Not planned |
| S3 backend | ✅ | ❌ | DB (bytea) or local-disk backend via `STORAGE_BACKEND` (`database`/`disk`); no S3 |

## Edge Functions

| Feature | Supabase | pgStack | Status |
|---------|:---:|:---:|:---:|
| Deno runtime | ✅ | ✅ | Wired (needs container) |
| Embedded JS (goja) | ❌ | ✅ | E2E tests |
| PL/v8 (in-PG JS) | ❌ | ✅ | Implemented |
| PL/Python3 | ❌ | ✅ | Implemented |
| JWT verification | ✅ | ✅ | Per-function flag |
| RLS enforcement | ✅ | ✅ | Per-call transactions |
| Function catalog (DB-backed) | ❌ | ✅ | NOTIFY auto-refresh |
| HTTP runtime (per-function container, any language) | ❌ | ✅ | `runtime='http'` + `upstream_url` in catalog |

## SDK

| Feature | Supabase | pgStack | Notes |
|---------|:---:|:---:|-------|
| `from().select().eq()` | ✅ | ✅ | Same API shape |
| `{ data, error, count }` | ✅ | ✅ | Same response format |
| `.single()`, `.maybeSingle()` | ✅ | ✅ | Implemented |
| `.insert()`, `.update()`, `.delete()` | ✅ | ✅ | Implemented |
| `.rpc()` | ✅ | ✅ | Implemented |
| React hooks (useAuth) | ✅ | ✅ | Implemented |
| Live query hook (useLiveQuery) | ❌ | ✅ | pgStack-only |
| `supabase.channel()` | ✅ | ⚠️ | Different API |

## Infrastructure

| Feature | Supabase | pgStack | Notes |
|---------|:---:|:---:|-------|
| Containers needed | 11 | 2 | PG + proxy |
| One-container mode | ❌ | ✅ | All-in-one Docker |
| Auto TLS (Let's Encrypt) | ✅ Cloud | ✅ Self-hosted | `TLS_MODE=auto` |
| Studio dashboard | ✅ | ✅ | 40 Playwright tests |
| Managed hosting | ✅ | ❌ | Self-hosted only |
| `auth.uid()` helper | ✅ | ✅ | In init.sql |

## Score Summary

| Layer | Coverage | Notes |
|-------|----------|-------|
| **REST API** | **90%** | Missing plfts/phfts/wfts (niche full-text variants) and upsert (no `ON CONFLICT`) |
| **Auth** | **90%** | Missing SMS, SAML (enterprise features) |
| **Storage** | **75%** | Missing image transforms, S3 backend, signed URLs |
| **Edge Functions** | **100%+** | More runtimes than Supabase |
| **Realtime** | **Different** | Strictly more powerful for query subscriptions; presence and custom broadcast channels supported (different protocol from Supabase Realtime) |
| **SDK** | **90%** | Different realtime API |
