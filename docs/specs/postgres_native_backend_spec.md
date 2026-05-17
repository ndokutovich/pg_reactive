# pgStack Platform Specification

**Version:** 1.0
**Last Updated:** 2026-03-01
**Status:** GA Preparation

---

## 1. Core Philosophy

**"PostgreSQL IS the application server."**

pgStack is built on a single architectural principle: every backend capability -- authentication, authorization, real-time data, storage, business logic -- should live inside PostgreSQL or be a thin translation layer over it.

**Design tenets:**

1. **Every feature is a SQL function or extension.** Authentication is SQL functions over an `auth.users` table. Authorization is Row-Level Security policies. Real-time is `pg_notify`. Storage is `bytea` columns.

2. **The proxy is a thin translator.** It translates HTTP and WebSocket into SQL. It holds no application state. If the proxy restarts, no data is lost.

3. **RLS enforces security at the database level.** The proxy sets the PostgreSQL role (`SET LOCAL ROLE`) based on the JWT. All queries execute under that role with RLS policies enforced by the database engine itself.

4. **Two processes, not fifteen.** PostgreSQL (with extensions) and one Go binary. That is the entire production stack.

---

## 2. Architecture

```
Client (Browser / Mobile / Server)
  |
  | HTTP / WebSocket
  v
pgstack-proxy (Go binary, ~15 MB)
  |
  |-- /auth/v1/*          Auth (JWT, OAuth, magic links, email verification)
  |-- /rest/v1/*          REST API (PostgREST-compatible CRUD, RPC, embedding)
  |-- /ws/{queryID}       Realtime (pg_reactive live queries)
  |-- /storage/v1/*       Storage (bytea file upload/download)
  |-- /studio/*           Admin Dashboard (React SPA)
  |-- /api/sql            SQL Endpoint (dev mode)
  |-- /health             Health check
  |-- /*                  User SPA (static files from PUBLIC_DIR)
  |
  | pgx connection pool (max 50 connections)
  v
PostgreSQL 16
  |-- pg_reactive         Live queries (C extension)
  |-- pgcrypto            Password hashing (bcrypt)
  |-- RLS policies        Row-level security
  |-- auth schema         Users, sessions, refresh tokens, OAuth
  |-- pgstack schema      Buckets, storage objects, DBOS jobs
```

### Process Model

| Process | Binary | Memory | Purpose |
|---------|--------|--------|---------|
| PostgreSQL 16 | `postgres` | Configurable (shared_buffers, work_mem) | Database, extensions, RLS, triggers, NOTIFY |
| pgstack-proxy | Single Go binary | ~30-50 MB RSS | HTTP/WS routing, JWT validation, connection pooling |

Contrast with Supabase's deployment model which requires Kong, GoTrue, PostgREST, Realtime (Elixir), Storage API, Meta, Studio, and several supporting services.

---

## 3. Authentication

### 3.1 Auth Flow

```
Client                          Proxy                      PostgreSQL
  |                               |                            |
  |-- POST /auth/v1/signup ------>|                            |
  |                               |-- INSERT auth.users ------>|
  |                               |-- INSERT auth.tokens ----->|
  |                               |<--- rows inserted ---------|
  |<-- { access_token, user } ----|                            |
  |                               |                            |
  |-- GET /rest/v1/todos -------->|                            |
  |   Authorization: Bearer JWT   |-- SET LOCAL ROLE auth ---->|
  |                               |-- SELECT * FROM todos ---->|
  |                               |<--- rows (RLS filtered) ---|
  |<-- [{ id: 1, ... }] ---------|                            |
```

### 3.2 Supported Auth Methods

| Method | Endpoint | Description |
|--------|----------|-------------|
| Email/password signup | `POST /auth/v1/signup` | Creates user, returns JWT |
| Password login | `POST /auth/v1/token?grant_type=password` | Validates credentials, returns JWT |
| Token refresh | `POST /auth/v1/token?grant_type=refresh_token` | Rotates refresh token (family-based reuse detection) |
| OAuth (Google) | `GET /auth/v1/authorize?provider=google` | PKCE (S256), redirects to provider |
| OAuth (GitHub) | `GET /auth/v1/authorize?provider=github` | PKCE (S256), redirects to provider |
| Magic link | `POST /auth/v1/magiclink` | Sends login link via email |
| Password reset | `POST /auth/v1/recover` | Sends recovery email |
| Email verification | `GET /auth/v1/verify?token=...` | Confirms email address |
| Get current user | `GET /auth/v1/user` | Returns user profile (requires JWT) |
| Update user | `PATCH /auth/v1/user` | Update profile/metadata (requires JWT) |
| Logout | `POST /auth/v1/logout` | Revokes refresh token |

### 3.3 JWT Structure

```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "role": "authenticated",
  "exp": 1709337600,
  "iat": 1709334000
}
```

- Algorithm: HS256
- Secret: Minimum 32 characters (enforced at startup)
- Access token expiry: Configurable (default 3600 seconds)
- Refresh token expiry: Configurable (default 30 days)

### 3.4 Admin API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/v1/admin/users` | GET | List all users (requires service_role key) |
| `/auth/v1/admin/users` | POST | Create user (requires service_role key) |
| `/auth/v1/admin/users/{id}` | DELETE | Delete user (requires service_role key) |

---

## 4. REST API

### 4.1 PostgREST Compatibility

pgStack implements the same query string API as PostgREST, enabling drop-in replacement for Supabase clients.

**CRUD Operations:**

```
GET    /rest/v1/{table}?select=col1,col2&col3=eq.value    SELECT
POST   /rest/v1/{table}                                     INSERT
PATCH  /rest/v1/{table}?col=eq.value                        UPDATE
DELETE /rest/v1/{table}?col=eq.value                        DELETE
```

**Filter Operators:**

| Operator | Example | SQL |
|----------|---------|-----|
| `eq` | `?status=eq.active` | `status = 'active'` |
| `neq` | `?status=neq.deleted` | `status != 'deleted'` |
| `gt` | `?age=gt.18` | `age > 18` |
| `gte` | `?age=gte.18` | `age >= 18` |
| `lt` | `?price=lt.100` | `price < 100` |
| `lte` | `?price=lte.100` | `price <= 100` |
| `like` | `?name=like.*john*` | `name LIKE '%john%'` |
| `ilike` | `?name=ilike.*john*` | `name ILIKE '%john%'` |
| `in` | `?id=in.(1,2,3)` | `id IN (1, 2, 3)` |
| `is` | `?deleted_at=is.null` | `deleted_at IS NULL` |

**Ordering and Pagination:**

```
GET /rest/v1/todos?order=created_at.desc&limit=10&offset=20
```

**Foreign Key Embedding:**

```
GET /rest/v1/posts?select=id,title,comments(id,body,author:users(name))
```

Generates a single query with JOINs and returns nested JSON.

### 4.2 RPC (Remote Procedure Calls)

```
POST /rest/v1/rpc/calculate_total
Content-Type: application/json
{"order_id": 42}

GET /rest/v1/rpc/get_stats?since=2025-01-01
```

- Set-returning functions (RETURNS TABLE / SETOF) return JSON arrays.
- Scalar functions return unwrapped values.
- The distinction is determined by `pg_proc.proretset`.

### 4.3 RLS Enforcement

Every REST request executes within a transaction that sets the role and claims:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"...","email":"...","role":"authenticated"}';
-- User query executes here, RLS policies apply
COMMIT;
```

When both a JWT `Authorization: Bearer` header and an `apikey` header are present, the JWT takes priority. This is critical: if the apikey matched first, authenticated requests would incorrectly run as `anon`.

### 4.4 Catalog Introspection

At startup, the proxy loads the schema catalog from `information_schema` and `pg_catalog`:

- Table names, column names, column types
- Foreign key relationships (for embedding)
- Function signatures (for RPC)

The catalog can be refreshed at runtime via `POST /api/catalog/refresh` (requires `service_role` key).

---

## 5. Realtime (pg_reactive)

### 5.1 How It Works

1. **Server-side subscription** -- The proxy (or admin client) calls `pgr.subscribe('query_id', 'SELECT ...')` via SQL.
2. **Client connects** -- Browser opens WebSocket to `/ws/{queryID}`.
3. **Data changes** -- INSERT, UPDATE, or DELETE on any tracked table fires an AFTER STATEMENT trigger.
4. **Delta computed** -- pg_reactive computes the EXCEPT diff, serializes as JSON, and calls `pg_notify('pgr', ...)`.
5. **Proxy fans out** -- The proxy's LISTEN loop receives the NOTIFY and broadcasts to all connected WebSocket clients subscribed to that `query_id`.
6. **Client updates** -- The SDK applies the delta to its local snapshot (removes deleted rows, appends inserted rows).

### 5.2 Client Integration

```typescript
import { createClient } from '@pgstack/sdk'

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key')

// Live query subscription
const lq = new LiveQuery('dashboard_orders', {
  url: 'ws://127.0.0.1:8080',
  token: session.access_token,
})

lq.on((event, data) => {
  if (event === 'delta') {
    console.log('Rows:', lq.snapshot)
  }
})

// React hook
function OrdersDashboard() {
  const { rows, state } = useLiveQuery('dashboard_orders', {
    url: 'ws://127.0.0.1:8080',
  })

  if (state === 'connecting') return <p>Loading...</p>
  return <table>{rows.map(row => <tr key={row.id}>...</tr>)}</table>
}
```

### 5.3 General-Purpose Channels

In addition to live queries, pgStack supports general-purpose pub/sub channels:

```typescript
const ch = pgstack.channel('chat')
ch.subscribe((event, data) => {
  if (event === 'message') console.log(data)
})
ch.send({ user: 'alice', text: 'Hello!' })
```

---

## 6. Storage

### 6.1 Architecture

File storage uses PostgreSQL `bytea` columns. This eliminates the need for a separate storage service or S3 configuration.

```sql
-- Internal storage schema (managed by the proxy)
CREATE TABLE pgstack.buckets (
  id TEXT PRIMARY KEY,
  public BOOLEAN DEFAULT false,
  file_size_limit INTEGER,
  allowed_mime_types TEXT[],
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pgstack.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES pgstack.buckets(id),
  name TEXT NOT NULL,
  data BYTEA,
  mime_type TEXT,
  size INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 6.2 API

```typescript
const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key')

// Upload
const { data, error } = await pgstack.storage
  .from('avatars')
  .upload('user/photo.png', file)

// Download
const { data: blob } = await pgstack.storage
  .from('avatars')
  .download('user/photo.png')

// List
const { data: files } = await pgstack.storage
  .from('avatars')
  .list('user/')

// Delete
await pgstack.storage
  .from('avatars')
  .remove(['user/photo.png'])

// Public URL
const { data: { publicUrl } } = pgstack.storage
  .from('avatars')
  .getPublicUrl('user/photo.png')
```

### 6.3 Tradeoffs

| Aspect | pgStack (bytea) | Supabase (S3) |
|--------|-----------------|---------------|
| Setup complexity | Zero (built into PostgreSQL) | Requires S3 or MinIO |
| Backup | Included in pg_dump | Separate backup |
| Transactions | Full ACID | Eventual consistency |
| Large files (>100 MB) | Not recommended | Designed for it |
| CDN integration | Not built-in | S3 + CloudFront |
| Cost at scale | PostgreSQL storage cost | S3 pricing (cheaper) |

For most applications (avatars, documents, small media), bytea storage is simpler and sufficient. For large-file workloads, disk-based storage is planned as a future enhancement.

---

## 7. Developer Experience

### 7.1 Getting Started

```bash
# Install CLI
npm install -g @pgstack/cli

# Create project
pgstack init myapp
cd myapp

# Start development environment (PostgreSQL + proxy)
pgstack dev

# Edit your schema
cat > migrations/001_create_todos.sql << 'SQL'
CREATE TABLE public.todos (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  done BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own todos"
  ON public.todos FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own todos"
  ON public.todos FOR INSERT
  WITH CHECK (user_id = auth.uid());
SQL

# Apply migrations
pgstack migration run

# Generate TypeScript types
pgstack generate

# Use in your app
```

### 7.2 TypeScript SDK

```typescript
import { createClient } from '@pgstack/sdk'

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key')

// Auth
const { error } = await pgstack.auth.signUp({
  email: 'user@example.com',
  password: 'secure-password',
})

// Query with type safety
interface Todo {
  id: number
  title: string
  done: boolean
}

const { data, error } = await pgstack
  .from<Todo>('todos')
  .select('*')
  .eq('done', false)
  .order('created_at', { ascending: false })
  .limit(10)

// Insert
await pgstack.from('todos').insert({
  title: 'Buy groceries',
  done: false,
})

// Update
await pgstack.from('todos').update({ done: true }).eq('id', 1)

// Delete
await pgstack.from('todos').delete().eq('id', 1)

// RPC
const { data: stats } = await pgstack.rpc('get_dashboard_stats', {
  since: '2025-01-01',
})
```

### 7.3 React Hooks

```tsx
import { useAuth, useLiveQuery, useRpc } from '@pgstack/sdk/react'

function App() {
  const { user, signInWithPassword, signOut, loading } = useAuth(
    'http://127.0.0.1:8080',
    'your-anon-key',
  )

  if (loading) return <p>Loading...</p>
  if (!user) return <LoginForm onLogin={signInWithPassword} />
  return <Dashboard user={user} onLogout={signOut} />
}

function Dashboard({ user }) {
  const { rows, state } = useLiveQuery('active_orders', {
    url: 'ws://127.0.0.1:8080',
  })
  const { data: stats, loading } = useRpc(pgstack, 'get_stats')

  return (
    <div>
      <h1>Welcome, {user.email}</h1>
      <p>Connection: {state}</p>
      <p>Active orders: {rows.length}</p>
      {!loading && <StatsPanel stats={stats} />}
    </div>
  )
}
```

### 7.4 CLI Commands

```bash
pgstack init <name>              # Scaffold project
pgstack dev                      # Start PostgreSQL + proxy
pgstack stop                     # Stop containers
pgstack deploy --host user@vps   # Deploy to production
pgstack migration new <name>     # Create migration file
pgstack migration run            # Apply pending migrations
pgstack migration rollback       # Roll back last migration
pgstack migration list           # Show migration status
pgstack db push                  # Push schema changes
pgstack db reset                 # Reset database
pgstack generate                 # Generate TypeScript types
pgstack dbos                     # DBOS job management
pgstack status                   # Show service status
pgstack studio                   # Open dashboard in browser
```

---

## 8. Security Model

### 8.1 Authentication Layer

| Mechanism | Description |
|-----------|-------------|
| JWT (HS256) | Access tokens signed with a shared secret (min 32 chars). Passed as `Authorization: Bearer` header. |
| API Keys | `anon` key for unauthenticated access, `service_role` key for admin operations. Passed as `apikey` header. |
| OAuth PKCE | S256 challenge for Google and GitHub OAuth flows. Prevents authorization code interception. |
| Refresh tokens | Family-based reuse detection. If a revoked token is replayed, the entire token family is revoked. |

### 8.2 Authorization Layer

```sql
-- Example RLS policies
CREATE POLICY "Public read" ON posts
  FOR SELECT USING (published = true);

CREATE POLICY "Author write" ON posts
  FOR ALL USING (author_id = auth.uid());

CREATE POLICY "Admin full access" ON posts
  FOR ALL TO service_role USING (true);
```

The proxy sets the PostgreSQL role before each request:

- **No auth / anon key** -- `SET LOCAL ROLE anon`
- **Valid JWT** -- `SET LOCAL ROLE authenticated`; JWT claims available via `current_setting('request.jwt.claims')`
- **Service role key** -- `SET LOCAL ROLE service_role` (bypasses RLS)

### 8.3 Rate Limiting

- Auth endpoints (`/auth/v1/signup`, `/auth/v1/token`): 30 requests per minute per IP (configurable via `AUTH_RATE_LIMIT`).
- Proxy-aware: uses `X-Forwarded-For` for IP resolution behind reverse proxies.

### 8.4 Security Headers

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `0` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | Strict (API) / Relaxed (Studio) |

### 8.5 Input Validation

- Query IDs: alphanumeric, underscores, hyphens only (max 64 chars). Validated at C extension level.
- SQL injection: All REST parameters are bound with explicit `::type` casts from pg_catalog column types.
- Role whitelist: `SET LOCAL ROLE` only allows known roles (anon, authenticated, service_role) to prevent injection.
- Storage object paths: rejected before any filesystem access if they contain `..`, an absolute prefix, a Windows drive letter, a UNC path, or a NUL byte — both for `database` and `disk` backends. Each upload/download/delete must resolve under `STORAGE_DIR/{bucketId}/`; sibling-bucket escape is blocked.
- Static asset paths (`/studio/*`, `/docs/*`, `PublicSPA`): same traversal guard (`safeStaticPath`) — request rejected with 404 before `http.ServeFile` is called.
- Default grants on `public` are scoped (since 2026-05): `anon` and `authenticated` get NO blanket `ALL TABLES IN SCHEMA public` access and NO future-table inheritance via `ALTER DEFAULT PRIVILEGES`. Each application table must declare its own grants (and should enable RLS). The shipped demo / e2e fixtures declare their grants explicitly. `service_role` retains blanket access for proxy internals. Existing deployments upgrade via `migrations/20260515200000_revoke_blanket_grants.sql`.
- At-rest credentials are not stored as plaintext (since 2026-05, finding F6):
    - `pgstack.refresh_tokens.token_hash` and `pgstack.email_tokens.token_hash` hold SHA-256 hex digests of the original tokens. The plaintext is returned to the client (or emailed) exactly once and never persisted. A stolen DB dump no longer yields valid session credentials.
    - `pgstack.edge_functions.env_vars_encrypted` is AES-256-GCM ciphertext under `SECRETS_ENCRYPTION_KEY` (32 random bytes, base64). The wire format is `[version=0x01][12-byte nonce][ciphertext+GCM tag]`. The old plaintext `env_vars JSONB` column has been removed.
    - Existing installs upgrade via `migrations/20260515210000_hash_tokens_encrypt_envvars.sql`; the migration cannot reverse-derive plaintext from missing data, so it force-rotates all refresh tokens (every user re-authenticates) and clears unused email tokens.

### 8.7 WebSocket message scope (since 2026-05)

Client-to-server WS frames are restricted to a typed whitelist:

- `{"type":"presence","state":{...}}` → presence-state update for the channel.
- `{"type":"broadcast","payload":<any>}` → peer-to-peer broadcast. The server rewraps as `{"type":"broadcast","from":<peer-id>,"payload":<original>}` before fanning out, so receivers cannot confuse a peer message with a server-generated live-query delta.

Everything else is dropped at debug level. Server-side live-query deltas flow exclusively from the PG `NOTIFY` listener; no client frame can inject events into that stream.

### 8.6 Realtime Authorization (since 2026-05)

WebSocket subscriptions (`GET /ws/{query_id}`) are authenticated against the `JWT_SECRET` like every other endpoint. Two knobs control how strict that gate is:

- **`REQUIRE_AUTHENTICATED_WS`** (env) — when `true`, anon-key holders are rejected. Only real JWTs (`authenticated` or `service_role`) may open a subscription. Set this whenever live queries return user-scoped data; otherwise a publicly-known anon key plus a guessed `query_id` becomes a read capability on someone else's live data.
- **Origin validation** — `ALLOWED_ORIGINS` (allow-list) and `ALLOW_PERMISSIVE_CORS` (dev override). With both empty, strict mode is in effect: only same-origin browsers and non-browser clients (no Origin header) can upgrade.

**audience-bound subscriptions (since pg_reactive 0.1.2):** `pgr.subscribe` accepts a fourth `audience jsonb` argument. When set, the proxy verifies at WS-connect time that every key in the audience matches the corresponding JWT claim. `service_role` JWTs always bypass; anon-key WS connections are rejected outright when audience is non-NULL. This closes the "authenticated JWT + guessable query_id reads anyone's live data" vector: even if a player A learns player B's channel name, A's JWT (`sub=A`) cannot satisfy B's subscription audience (`{"sub":"B"}`). Capability-via-unguessable-id remains the right pattern for short-lived or rotating channels; audience is the right pattern for long-lived user-scoped queries.

```sql
SELECT pgr.subscribe(
  'inv_' || player_id::text,
  format('SELECT name, count FROM player_inventory WHERE player_id = %L', player_id),
  'delta',
  jsonb_build_object('sub', player_id::text));
```

---

## 9. Proxy Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://postgres:postgres@db:5432/app` | PostgreSQL connection string |
| `LISTEN_ADDR` | `0.0.0.0:8080` | HTTP listen address |
| `JWT_SECRET` | (none, auth disabled) | JWT signing secret (min 32 chars) |
| `ANON_KEY` | (none) | Anonymous API key |
| `SERVICE_ROLE_KEY` | (none) | Admin API key |
| `MAX_CONNECTIONS` | 10000 | Maximum WebSocket connections |
| `BROADCAST_CAPACITY` | 1024 | Broadcast channel buffer size |
| `MAX_BODY_SIZE` | 1048576 (1 MB) | Maximum HTTP body size |
| `AUTH_RATE_LIMIT` | 30 | Auth endpoint rate limit (per minute per IP) |
| `AUTH_RATE_WINDOW` | 60 | Rate limit window (seconds) |
| `ACCESS_TOKEN_EXPIRY_SECS` | 3600 | JWT access token lifetime |
| `REFRESH_TOKEN_EXPIRY_DAYS` | 30 | Refresh token lifetime |
| `GOOGLE_CLIENT_ID` | (none) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | (none) | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | (none) | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | (none) | GitHub OAuth client secret |
| `SITE_URL` | (none) | Application URL for OAuth callbacks |
| `SMTP_HOST` | (none) | SMTP server for email |
| `SMTP_PORT` | 587 | SMTP port |
| `SMTP_USER` | (none) | SMTP username |
| `SMTP_PASS` | (none) | SMTP password |
| `SMTP_FROM` | `noreply@pgstack.local` | Sender email address |
| `REQUIRE_EMAIL_VERIFICATION` | false | Require email verification before login |
| `ALLOWED_ORIGINS` | (empty) | CORS / WS origin allow-list. Empty = strict (see `ALLOW_PERMISSIVE_CORS`). |
| `ALLOW_PERMISSIVE_CORS` | false | When `ALLOWED_ORIGINS` is empty and this is true, reflect any Origin with credentials (DEV ONLY). |
| `REQUIRE_AUTHENTICATED_WS` | false | Reject anon-key WS subscriptions; require JWT for `/ws/{query_id}`. |
| `ENABLE_SQL_ENDPOINT` | false | Enable `/api/sql` endpoint (dev only) |
| `ENABLE_DEMO_ENDPOINT` | false | Mount `POST /api/demo` (demo-table mutator). Off by default. |
| `STUDIO_DIR` | `/studio` | Path to Studio SPA files |
| `PUBLIC_DIR` | (none) | Path to user static files |
| `LOG_PRETTY` | 0 | Pretty-print logs (1 = human-readable) |
| `PG_RECONNECT_MAX_BACKOFF` | 30 | Max backoff for LISTEN reconnect (seconds) |

---

## 10. Comparison with Alternatives

| | pgStack | Supabase | Firebase | Convex | PocketBase |
|--|---------|----------|----------|--------|------------|
| **Database** | PostgreSQL 16 | PostgreSQL 15 | Firestore (NoSQL) | Custom (OCC) | SQLite |
| **Language** | Go + C | Haskell + Elixir + Go | Proprietary | Rust + TypeScript | Go |
| **Containers** | 2 | 15+ | Managed | Managed | 1 |
| **Self-host** | Simple | Complex | No | No | Simple |
| **Live Queries** | SQL-level (EXCEPT diff) | Table-level (WAL) | Document-level | Reactive queries | No |
| **Auth** | Built-in | GoTrue (separate) | Built-in | Built-in | Built-in |
| **REST** | PostgREST-compatible | PostgREST | REST/gRPC | Convex functions | REST |
| **Storage** | bytea (PostgreSQL) | S3 | GCS | Built-in | Filesystem |
| **Edge Functions** | Planned | Deno | Cloud Functions | Convex actions | No |
| **Open Source** | MIT | Apache 2.0 | No | BSL | MIT |
| **Pricing** | Free (self-hosted) | Freemium | Pay-per-use | Freemium | Free |
| **SQL Support** | Full PostgreSQL | Full PostgreSQL | No SQL | No SQL | SQLite |
| **RLS** | PostgreSQL native | PostgreSQL native | Security Rules | Validators | No |
| **Binary Size** | ~15 MB (proxy) | N/A (many services) | N/A | N/A | ~25 MB |

### When to Choose pgStack

- You want PostgreSQL and do not want to manage 15 containers.
- You need SQL-level live queries (not just table-level change feeds).
- You want a single self-hosted binary plus PostgreSQL.
- You want Supabase-compatible SDK but simpler deployment.
- You are building dashboards, admin panels, or collaborative apps that benefit from EXCEPT-based diffs.

### When to Choose Alternatives

- **Supabase** -- You need the full ecosystem (many OAuth providers, Edge Functions, managed hosting).
- **Firebase** -- You prefer managed NoSQL with offline-first mobile SDKs.
- **Convex** -- You want managed reactive queries with TypeScript-native data model.
- **PocketBase** -- You want a single-file backend for prototyping.

---

## 11. Deployment

### 11.1 Development

```yaml
# docker-compose.yml (generated by pgstack init)
# DEMO ONLY — real secrets live in .env, never inline. Generate with:
#   for v in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRETS_ENCRYPTION_KEY; do
#     printf '%s=%s\n' "$v" "$(openssl rand -base64 32)" >> .env
#   done
services:
  db:
    image: pgstack/postgres:16
    env_file: .env       # POSTGRES_PASSWORD
    environment:
      POSTGRES_DB: app
    ports:
      - "15432:5432"

  proxy:
    image: pgstack/proxy:latest
    env_file: .env       # JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
                         # SECRETS_ENCRYPTION_KEY, POSTGRES_PASSWORD
    environment:
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/app
      PGSTACK_ENV: production
    ports:
      - "8080:8080"
    depends_on:
      - db
```

```bash
docker compose up -d
# PostgreSQL available at 127.0.0.1:15432
# Proxy available at 127.0.0.1:8080
# Studio available at 127.0.0.1:8080/studio/
```

### 11.2 Production

```bash
pgstack deploy --host user@your-server.com
```

This command:
1. Builds Docker images locally.
2. Pushes images to the server via SSH.
3. Copies the docker-compose and .env files.
4. Runs `docker compose up -d` on the server.

### 11.3 CI/CD

GitHub Actions workflows are provided:
- **ci.yml** -- Runs tests on push (pg_regress, SDK tests, E2E tests).
- **release.yml** -- Builds and pushes Docker images to GHCR on tag.
