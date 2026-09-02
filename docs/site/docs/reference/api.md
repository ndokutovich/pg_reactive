---
title: API Reference
sidebar_position: 1
description: Complete REST and WebSocket API reference for pgStack.
---

# API Reference

Complete reference for all pgStack proxy endpoints.

## Base URL

```
http://127.0.0.1:8080   (development)
https://your-app.example.com  (production)
```

## Authentication Levels

| Level | Header | Description |
|-------|--------|-------------|
| **None** | *(none)* | No authentication required |
| **apikey** | `apikey: <ANON_KEY>` | Anonymous access, subject to RLS |
| **JWT** | `Authorization: Bearer <access_token>` | Authenticated user, subject to RLS |
| **service_role** | `Authorization: Bearer <SERVICE_ROLE_KEY>` | Admin access, bypasses RLS |

When both `Authorization` and `apikey` headers are present, the JWT is validated first.

---

## Route Summary

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/v1/signup` | None (rate-limited) | Register new user |
| `POST` | `/auth/v1/token?grant_type=password` | None (rate-limited) | Sign in with email/password |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | None (rate-limited) | Refresh access token |
| `POST` | `/auth/v1/anonymous` | None | Create a guest account (0.3.0): real `pgstack.users` row, access token with `role=anonymous` (`ANONYMOUS_ROLE`) + `is_anonymous:true`, **and a refresh token**. Requires `ALLOW_ANONYMOUS_SIGNIN=true`, otherwise `503`. Separate rate-limit bucket (`ANONYMOUS_RATE_LIMIT`) |
| `GET` | `/auth/v1/user` | JWT | Get current user profile |
| `PATCH` | `/auth/v1/user` | JWT | Update current user |
| `POST` | `/auth/v1/logout` | JWT | Sign out, invalidate refresh token |
| `POST` | `/auth/v1/recover` | None (rate-limited) | Send password recovery email |
| `POST` | `/auth/v1/recover/confirm` | None | Confirm password reset with token |
| `POST` | `/auth/v1/magiclink` | None (rate-limited) | Send magic link email |
| `GET` | `/auth/v1/magiclink/verify` | None | Verify magic link token |
| `GET` | `/auth/v1/verify` | None | Verify email confirmation token |
| `GET` | `/auth/v1/authorize?provider={name}` | None | Start OAuth flow (google, github, apple, microsoft, oidc) |
| `GET` | `/auth/v1/callback` | None | OAuth callback (internal) |
| `POST` | `/auth/v1/callback` | None | OAuth callback — form_post (Apple) |

### Auth Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/auth/v1/admin/users` | service_role | List all users |
| `POST` | `/auth/v1/admin/users` | service_role | Create a user |
| `DELETE` | `/auth/v1/admin/users/{id}` | service_role | Delete a user |

### REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/rest/v1/` | apikey/JWT | OpenAPI 2.0 spec of exposed tables |
| `GET` | `/rest/v1/rls-debug` | apikey/JWT | Echo resolved role/claims for RLS debugging |
| `GET` | `/rest/v1/{table}` | apikey/JWT | Select rows |
| `POST` | `/rest/v1/{table}` | apikey/JWT | Insert row(s) |
| `PATCH` | `/rest/v1/{table}` | apikey/JWT | Update rows (filter required) |
| `DELETE` | `/rest/v1/{table}` | apikey/JWT | Delete rows (filter required) |
| `POST` | `/rest/v1/batch` | apikey/JWT | Batch transaction |

### RPC

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/rest/v1/rpc/{function}` | apikey/JWT | Call function (JSON params in body) |
| `GET` | `/rest/v1/rpc/{function}` | apikey/JWT | Call function (query string params) |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/rest/v1/webhooks` | service_role | Register a webhook |
| `GET` | `/rest/v1/webhooks` | service_role | List all webhooks |
| `DELETE` | `/rest/v1/webhooks/{id}` | service_role | Delete a webhook |

### Edge Functions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/functions/v1/{name}` | apikey/JWT | Invoke edge function |
| `GET` | `/functions/v1/{name}` | apikey/JWT | Invoke edge function (GET) |
| `GET` | `/functions/v1/` | service_role | List all functions |
| `POST` | `/functions/v1/_refresh` | service_role | Reload function catalog |

### Storage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/storage/v1/bucket` | service_role | Create bucket |
| `GET` | `/storage/v1/bucket` | apikey/JWT | List buckets |
| `DELETE` | `/storage/v1/bucket/{bucketId}` | service_role | Delete bucket |
| `POST` | `/storage/v1/object/{bucket}/*` | apikey/JWT | Upload file |
| `GET` | `/storage/v1/object/list/{bucket}` | apikey/JWT | List objects in bucket |
| `GET` | `/storage/v1/object/{bucket}/*` | apikey/JWT | Download file |
| `DELETE` | `/storage/v1/object/{bucket}/*` | apikey/JWT | Delete file |

The object path (`*` wildcard) is validated server-side: requests that traverse out of the bucket (`..`, absolute paths, drive letters, UNC paths, NUL bytes) are rejected with `400 Bad Request` before any filesystem access. This applies to both `STORAGE_BACKEND=database` and `STORAGE_BACKEND=disk`.

### WebSocket

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ws/{query_id}` | anon/JWT (see note) | Live query WebSocket connection |
| `GET` | `/ws/_presence/{channel}` | anon/JWT | Get current presence state for a channel |

By default the anon key is accepted for live-query subscriptions. Set `REQUIRE_AUTHENTICATED_WS=true` to reject anon-key WS connections and require a real JWT (`authenticated` or `service_role`) — recommended whenever live queries return user-scoped data. The Origin header is validated against `ALLOWED_ORIGINS`; with an empty allow-list, only same-origin and non-browser clients are accepted (strict default) unless `ALLOW_PERMISSIVE_CORS=true` is set for dev.

### Dev-only

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/sql` | service_role | Execute raw SQL (requires `ENABLE_SQL_ENDPOINT=true`) |
| `POST` | `/api/catalog/refresh` | service_role | Refresh the REST catalog (re-introspect schema); returns `{"ok": true}` |
| `POST` | `/api/demo` | service_role / disabled | Mutates demo tables. Only mounted when `ENABLE_DEMO_ENDPOINT=true` OR a `SERVICE_ROLE_KEY` is configured (which it then requires). Off by default. |

---

## Health

### GET /health

Returns proxy status.

**No authentication required.**

```bash
curl http://127.0.0.1:8080/health
```

Response `200 OK`:

```json
{
  "status": "ok",
  "pg_connected": true
}
```

Response `503 Service Unavailable` (PostgreSQL unreachable):

```json
{
  "status": "degraded",
  "pg_connected": false
}
```

---

## Authentication Endpoints

### POST /auth/v1/signup

Register a new user with email and password.

**Headers:** none required (Supabase clients send `apikey`/`Authorization: Bearer <ANON_KEY>` by convention; the proxy does not enforce it). Rate-limited per IP (`AUTH_RATE_LIMIT`).

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "strongpassword123",
  "data": { "full_name": "Jane Doe" }
}
```

`data` is optional — stored as `user_metadata`.

**Response `201 Created`:**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "expires_in": 3600,
  "token_type": "bearer",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "authenticated",
    "user_metadata": { "full_name": "Jane Doe" },
    "created_at": "2025-01-14T12:00:00Z",
    "updated_at": "2025-01-14T12:00:00Z"
  }
}
```

When `REQUIRE_EMAIL_VERIFICATION=true`, the response is instead `200 OK` with `{"message": "Check your email to confirm your account"}` and no tokens are issued until the email is verified.

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | `invalid request body` / `invalid email address` | Malformed JSON or bad email |
| `400` | `password must be at least 8 characters` | Password too short (also: `password must be at most 256 characters`) |
| `409` | `email already registered` | Email already exists |

Error bodies are `{"error": "<message>"}` strings, not machine codes.

---

### POST /auth/v1/token

Sign in or refresh tokens.

**Headers:** none required (Supabase clients send `apikey`/`Authorization: Bearer <ANON_KEY>` by convention; the proxy does not enforce it). Rate-limited per IP (`AUTH_RATE_LIMIT`).

#### Sign in with password

**Query:** `?grant_type=password`

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "strongpassword123"
}
```

**Response `200 OK`:** Same as signup response.

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `401` | `invalid email or password` | Wrong email or password |

#### Refresh access token

**Query:** `?grant_type=refresh_token`

**Request body:**

```json
{
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Response `200 OK`:** New `access_token` + rotated `refresh_token`.

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `401` | `invalid refresh token` | Refresh token not found (also: `refresh token expired`) |

---

### GET /auth/v1/user

Get the current user's profile.

**Headers:** `Authorization: Bearer <access_token>`

**Response `200 OK`:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "role": "authenticated",
  "user_metadata": {},
  "created_at": "2025-01-14T12:00:00Z",
  "updated_at": "2025-01-14T12:00:00Z"
}
```

---

### PATCH /auth/v1/user

Update the current user's email, password, or metadata.

**Headers:** `Authorization: Bearer <access_token>`

**Request body (all fields optional):**

```json
{
  "email": "newemail@example.com",
  "password": "newpassword456",
  "data": { "full_name": "Jane Smith" }
}
```

**Response `200 OK`:** Updated user object.

---

### POST /auth/v1/logout

Sign out and invalidate the refresh token.

**Headers:** `Authorization: Bearer <access_token>`

**Request body:**

```json
{}
```

**Response `204 No Content`**

---

### POST /auth/v1/recover

Send a password recovery email. The email contains a link with a reset token.

**Headers:** none required (Supabase clients send `apikey`/`Authorization: Bearer <ANON_KEY>` by convention; the proxy does not enforce it). Rate-limited per IP (`AUTH_RATE_LIMIT`).

**Request body:**

```json
{
  "email": "user@example.com"
}
```

**Response `200 OK`:**

```json
{
  "message": "If this email exists, a reset link has been sent"
}
```

The response is identical whether or not the email is registered (anti-enumeration).

---

### POST /auth/v1/recover/confirm

Confirm a password reset using the token from the recovery email.

**No authentication required.**

**Request body:**

```json
{
  "token": "reset-token-from-email",
  "password": "newpassword456"
}
```

**Response `200 OK`:**

```json
{
  "message": "Password updated"
}
```

No tokens are issued — sign in with the new password to obtain a session.

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | `invalid or expired token` | Token expired or already used |
| `400` | `password must be at least 8 characters` | Password too short |

---

### POST /auth/v1/magiclink

Send a magic link email for passwordless sign-in.

**Headers:** none required (Supabase clients send `apikey`/`Authorization: Bearer <ANON_KEY>` by convention; the proxy does not enforce it). Rate-limited per IP (`AUTH_RATE_LIMIT`).

**Request body:**

```json
{
  "email": "user@example.com"
}
```

**Response `200 OK`:**

```json
{
  "message": "Magic link sent"
}
```

---

### GET /auth/v1/magiclink/verify

Verify a magic link token and return an access token. Typically visited by clicking the link in the email.

**No authentication required.**

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | The magic link token from the email |

```
GET /auth/v1/magiclink/verify?token=magic-link-token
```

**Response `302 Found`:** Redirects to `{SITE_URL}#access_token=...&refresh_token=...&token_type=bearer&expires_in=N`. The client reads the tokens from the URL fragment.

---

### GET /auth/v1/verify

Verify an email confirmation token. Sent after signup when email verification is enabled.

**No authentication required.**

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | The email verification token |

```
GET /auth/v1/verify?token=email-verification-token
```

**Response `200 OK`:** Confirmation result.

---

### GET /auth/v1/authorize

Start an OAuth authorization flow. Redirects the browser to the provider.

**No authentication required.**

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `provider` | Yes | `google`, `github`, `apple`, `microsoft`, or `oidc` |
| `redirect_to` | No | Override the post-login redirect URL |

```
GET /auth/v1/authorize?provider=google
GET /auth/v1/authorize?provider=github&redirect_to=https://app.example.com/dashboard
```

**Response:** `302 Found` — redirects to OAuth provider.

---

### GET /auth/v1/callback

OAuth callback endpoint. The OAuth provider redirects here after the user authorizes. Exchanges the authorization code for tokens and redirects the user to the application.

**No authentication required.** Called internally by the OAuth provider.

---

## Auth Admin Endpoints

These endpoints require a `service_role` key and bypass RLS.

### GET /auth/v1/admin/users

List all users.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

**Response `200 OK`:** Array of user objects.

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "authenticated",
    "created_at": "2025-01-14T12:00:00Z"
  }
]
```

---

### POST /auth/v1/admin/users

Create a new user (admin).

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`, `Content-Type: application/json`

**Request body:**

```json
{
  "email": "newuser@example.com",
  "password": "initialpassword",
  "role": "authenticated",
  "email_confirm": true
}
```

`password` is optional (min 8 / max 256 chars when given). `role` defaults to `authenticated` and must be one of `anon`, `authenticated`, `service_role`. There is no `data`/metadata field — unknown fields are ignored.

**Response `201 Created`:** Created user object.

**Errors:** `409` when the email is already registered.

---

### DELETE /auth/v1/admin/users/&#123;id&#125;

Delete a user by ID.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

```bash
DELETE /auth/v1/admin/users/550e8400-e29b-41d4-a716-446655440000
```

**Response `204 No Content`** (empty body). Returns `404` `{"error": "user not found"}` when the id does not exist, `400` for a malformed UUID.

---

## REST API Endpoints

All REST endpoints follow the pattern `/rest/v1/&#123;table&#125;`.

### GET /rest/v1/&#123;table&#125;

Query rows from a table.

**Headers:** `Authorization: Bearer <token>`

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `select` | Columns to return (default: `*`). Supports FK embedding: `id,customers(name)` |
| `{column}={op}.{value}` | Filter (e.g., `status=eq.active`) |
| `order` | Sort: `column.asc` or `column.desc`. Multiple: `col1.asc,col2.desc` |
| `limit` | Max rows to return (no default — all matching rows are returned when omitted) |
| `offset` | Skip N rows |

**Filter operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `cs`, `cd`, `ov`, `fts`, `sl`, `sr`, `nxl`, `nxr`, `adj`. Prefix any operator with `not.` to negate it (e.g. `status=not.eq.active`).

**Logical combinators:** `or=(col1.eq.val1,col2.eq.val2)`, `and=(col1.gt.0,col1.lt.100)`

**Prefer header for count:**

| Header | Description |
|--------|-------------|
| `Prefer: count=exact` | Exact total row count (`count(*)`) in `Content-Range` response header |
| `Prefer: count=planned` | Planner-estimated count in `Content-Range` |
| `Prefer: count=estimated` | Estimated count in `Content-Range` |

```bash
# Examples
GET /rest/v1/todos?done=eq.false&order=created_at.desc&limit=20
GET /rest/v1/products?price=gte.10&price=lte.200&active=eq.true
GET /rest/v1/users?deleted_at=is.null
GET /rest/v1/orders?status=in.(pending,processing)
GET /rest/v1/orders?or=(status.eq.pending,status.eq.shipped)
```

**Response `200 OK`:** JSON array of rows.

**Response header** (with `Prefer: count=exact`): `Content-Range: 0-19/42`

---

### POST /rest/v1/&#123;table&#125;

Insert one or more rows.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request body:** Single row object or array of row objects.

```json
{"title": "Buy groceries", "done": false}
```

```json
[
  {"title": "Buy groceries"},
  {"title": "Walk the dog"}
]
```

**Response `201 Created`:** Inserted row(s).

With `Prefer: return=minimal`, the response is `201 Created` with no body.

#### Upsert

Upsert (`Prefer: resolution=merge-duplicates` with `on_conflict=column`) is not yet supported; POST always performs a plain insert and duplicate keys return a conflict error.

---

### PATCH /rest/v1/&#123;table&#125;

Update rows matching the filter.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

Requires at least one filter parameter to avoid accidentally updating all rows.

```bash
PATCH /rest/v1/todos?id=eq.42
{"done": true}
```

**Response `200 OK`:** Updated row(s).

---

### DELETE /rest/v1/&#123;table&#125;

Delete rows matching the filter.

Requires at least one filter parameter.

```bash
DELETE /rest/v1/todos?id=eq.42
DELETE /rest/v1/sessions?expires_at=lt.2025-01-01T00:00:00Z
```

**Response `200 OK`:** Deleted row(s).

---

### POST /rest/v1/batch

Execute multiple REST operations in a single database transaction.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request body:**

```json
{
  "atomic": true,
  "operations": [
    { "id": "create", "method": "POST", "path": "/rest/v1/orders", "body": {"total": 99.99} },
    { "id": "item", "method": "POST", "path": "/rest/v1/order_items",
      "body": {"order_id": "{{create.id}}", "product_id": 7} }
  ]
}
```

**Response `200 OK`** (atomic, all succeed):

```json
{
  "results": [
    { "id": "create", "status": 201, "data": {"id": 42, "total": 99.99} },
    { "id": "item", "status": 201, "data": {"id": 1, "order_id": 42, "product_id": 7} }
  ]
}
```

**Response `422`** (atomic, one fails): All rolled back. Includes `error` and `failed_operation`.

**Response `207`** (partial mode, `"atomic": false`): Mix of successes and failures. Check each result's `status`.

See [Transaction Batching](../rest/batch) for full documentation.

---

## RPC Endpoints

### POST /rest/v1/rpc/&#123;function&#125;

Call a PostgreSQL function with JSON parameters.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request body:** Function parameters as a JSON object.

```bash
POST /rest/v1/rpc/get_order_total
{"p_order_id": 42}
```

**Response `200 OK`:** Function return value (scalar, row, or array).

- **Scalar functions** (e.g., `RETURNS integer`): bare value (e.g., `42`).
- **Set-returning functions** (e.g., `RETURNS TABLE`, `RETURNS SETOF`): JSON array, even for single-row results.

---

### GET /rest/v1/rpc/&#123;function&#125;

Call a read-only PostgreSQL function with query string parameters.

```bash
GET /rest/v1/rpc/get_dashboard_stats
GET /rest/v1/rpc/search_products?term=laptop&limit=10
```

**Response `200 OK`:** Function return value.

---

## Edge Functions Endpoints

### POST /functions/v1/&#123;name&#125;

Invoke an edge function.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request body:** Function-specific JSON payload.

```bash
POST /functions/v1/send-email
{"to": "user@example.com", "subject": "Hello"}
```

**Response `200 OK`:** Function return value (JSON).

---

### GET /functions/v1/&#123;name&#125;

Invoke an edge function via GET (for read-only functions).

```bash
GET /functions/v1/health-check
```

**Response `200 OK`:** Function return value (JSON).

---

### GET /functions/v1/

List all registered edge functions.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

**Response `200 OK`:**

```json
[
  { "name": "send-email", "runtime": "deno", "status": "active", "verify_jwt": true },
  { "name": "process-order", "runtime": "plv8", "status": "active", "verify_jwt": true }
]
```

---

### POST /functions/v1/_refresh

Reload the functions catalog from the database.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

**Response `200 OK`:** `{"ok": true}`

---

## Storage Endpoints

### POST /storage/v1/bucket

Create a new storage bucket.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`, `Content-Type: application/json`

**Request body:**

```json
{
  "name": "avatars",
  "public": false
}
```

The request body accepts `id` or `name` (id wins), plus `public`, `file_size_limit`, `allowed_mime_types`.

**Response `201 Created`:**

```json
{
  "id": "avatars",
  "public": false,
  "file_size_limit": 52428800,
  "allowed_mime_types": null,
  "created_at": "2025-01-14T12:00:00Z"
}
```

---

### GET /storage/v1/bucket

List all storage buckets.

**Headers:** `Authorization: Bearer <token>`

**Response `200 OK`:**

```json
[
  { "id": "avatars", "public": false, "file_size_limit": 52428800, "allowed_mime_types": null, "created_at": "2025-01-14T12:00:00Z" },
  { "id": "uploads", "public": true, "file_size_limit": 52428800, "allowed_mime_types": null, "created_at": "2025-01-14T12:00:00Z" }
]
```

---

### DELETE /storage/v1/bucket/&#123;bucketId&#125;

Delete a storage bucket. The bucket must be empty.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

```bash
DELETE /storage/v1/bucket/avatars
```

**Response `200 OK`:**

```json
{"message": "bucket deleted"}
```

---

### POST /storage/v1/object/&#123;bucket&#125;/\*

Upload a file to a bucket. The path after the bucket name becomes the object path.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: multipart/form-data` or binary

```bash
POST /storage/v1/object/avatars/users/123/photo.png
```

**Response `200 OK`:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "key": "avatars/users/123/photo.png"
}
```

---

### GET /storage/v1/object/list/&#123;bucket&#125;

List objects in a bucket.

**Headers:** `Authorization: Bearer <token>`

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `prefix` | Filter by path prefix |

```bash
GET /storage/v1/object/list/avatars?prefix=users/123/
```

**Response `200 OK`:** Array of object metadata.

```json
[
  { "id": "550e8400-e29b-41d4-a716-446655440000", "name": "users/123/photo.png", "size": 12345, "mime_type": "image/png", "created_at": "2025-01-14T12:00:00Z" }
]
```

---

### GET /storage/v1/object/&#123;bucket&#125;/\*

Download a file from a bucket.

**Headers:** `Authorization: Bearer <token>`

```bash
GET /storage/v1/object/avatars/users/123/photo.png
```

**Response `200 OK`:** File contents with appropriate `Content-Type` header.

---

### DELETE /storage/v1/object/&#123;bucket&#125;/\*

Delete a file from a bucket.

**Headers:** `Authorization: Bearer <token>`

```bash
DELETE /storage/v1/object/avatars/users/123/photo.png
```

**Response `200 OK`:**

```json
{"message": "object deleted"}
```

---

## Webhooks

Webhooks deliver real-time database change notifications to external HTTP endpoints.

### POST /rest/v1/webhooks

Register a new webhook.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`, `Content-Type: application/json`

**Request body:**

```json
{
  "url": "https://example.com/hook",
  "events": ["INSERT", "UPDATE", "DELETE"],
  "table_name": "orders",
  "secret": "whsec_your-signing-secret"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `url` | *(required)* | Endpoint URL to receive webhook POST requests. |
| `events` | `["*"]` | Array of event types to deliver. `*` matches all. |
| `table_name` | `*` | Table name to filter on. `*` matches all tables. |
| `secret` | `""` | Signing secret for HMAC-SHA256 payload verification. |

Registering a webhook with a specific `table_name` installs an `AFTER INSERT OR
UPDATE OR DELETE` row trigger on that table; deleting the last webhook for a
table removes it. A `table_name` of `*` is a **wildcard matcher only** — it
receives every webhook event but cannot install a trigger itself (PostgreSQL
has no all-tables row trigger), so it relies on the triggers installed by
table-specific webhooks.

**Response `201 Created`:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://example.com/hook",
  "events": ["INSERT", "UPDATE", "DELETE"],
  "table_name": "orders",
  "active": true,
  "created_at": "2025-01-14T12:00:00Z"
}
```

---

### GET /rest/v1/webhooks

List all registered webhooks.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

**Response `200 OK`:** Array of webhook objects.

---

### DELETE /rest/v1/webhooks/&#123;id&#125;

Delete a webhook by ID.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

```bash
DELETE /rest/v1/webhooks/550e8400-e29b-41d4-a716-446655440000
```

**Response `200 OK`:**

```json
{"message": "webhook deleted"}
```

---

### Webhook delivery format

When a matching database change occurs, pgStack sends a POST request to the webhook URL:

```json
{
  "event": "INSERT",
  "table": "orders",
  "record": {"id": 42, "status": "pending", "amount": 149.99}
}
```

The `record` and `old_record` fields are omitted entirely when not applicable (e.g. `old_record` for INSERT, `record` for DELETE).

**Headers sent with each delivery:**

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Webhook-Signature` | `sha256=<hex>` — HMAC-SHA256 of the request body, using the webhook secret. Only present when `secret` is set. |
| `User-Agent` | `pgstack-webhooks/1.0` |

**Retry policy:** 3 attempts — the first is immediate, with retries after 1s and 4s. Non-2xx responses (and network errors/timeouts) trigger a retry.

**Verification example (Node.js):**

```javascript
const crypto = require('crypto');

function verifyWebhook(body, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

---

## WebSocket API

### WS /ws/&#123;query_id&#125;

Connect to a live query subscription.

**URL format:**

```
ws://127.0.0.1:8080/ws/{query_id}
ws://127.0.0.1:8080/ws/{query_id}?token={jwt}
```

The `query_id` must be registered with `pgr.subscribe()` in PostgreSQL.

**Connection confirmation** (server to client):

```json
{"type": "subscribed", "query_id": "active_orders"}
```

**Delta message** (server to client):

```json
{
  "query_id": "active_orders",
  "seq": 7,
  "inserted": [
    {"id": 42, "status": "pending", "amount": 149.99}
  ],
  "deleted": [
    {"id": 37, "status": "pending", "amount": 29.99}
  ]
}
```

`seq` is a per-subscription monotonically increasing counter; a gap in `seq` means a notification was missed and the client should re-fetch.

**Invalidated message** (server to client, for subscriptions registered with `mode='notify'`):

```json
{"type": "invalidated", "query_id": "active_orders", "seq": 7}
```

Sent instead of deltas; the client should re-fetch the result set via the REST API.

**Overflow message** (server to client, when the delta exceeds the NOTIFY payload limit: 8000 − channel-name length − 100 bytes, i.e. 7897 for the default `pgr` channel):

```json
{"type": "overflow", "query_id": "active_orders", "seq": 8, "fetch": true}
```

When overflow occurs, clear the local snapshot and re-fetch via the REST API. The same message is also emitted when the stored snapshot's column layout drifts from the live query, forcing a full resync.

**Broadcast message** (client to server, fanned out to peers):

```json
{"type": "broadcast", "payload": {"any": "JSON"}}
```

The server wraps it and delivers to all clients on the same `query_id` channel:

```json
{"type": "broadcast", "from": "a1b2c3d4e5f6...", "payload": {"any": "JSON"}}
```

`from` is the server-generated client ID, so peers cannot spoof it.

**Connection errors:** there is no in-stream error frame. Auth, audience, origin, and capacity failures are rejected before the WebSocket upgrade as plain HTTP responses with body `{"error": "<message>"}` and status `401` (auth required/invalid), `403` (audience not satisfied), `404` (subscription not found), or `503` (connection limit / metadata unavailable).

---

### Presence

Presence tracks which clients are connected to a channel and their current state. Presence is ephemeral — it is held in memory and lost on proxy restart.

#### Sending presence updates

Clients can update their presence state by sending a JSON message over the WebSocket:

```json
{"type": "presence", "state": {"username": "jane", "cursor": {"x": 100, "y": 200}}}
```

#### Presence events (server to client)

| Type | Description |
|------|-------------|
| `{"type":"presence_join","channel":"...","client_id":"...","state":{}}` | Client joined |
| `{"type":"presence_leave","channel":"...","client_id":"..."}` | Client disconnected |
| `{"type":"presence_state","channel":"...","client_id":"...","state":{}}` | Client updated state |

#### GET /ws/_presence/&#123;channel&#125;

Poll the current presence state for a channel via HTTP.

**Same auth + audience gate as the WebSocket upgrade path.** Pass either the anon key (when `REQUIRE_AUTHENTICATED_WS=false` and the channel has no audience), a JWT (`Authorization: Bearer …` or `?token=…`), or the `service_role` key. An audience-bound channel rejects anon and any JWT whose claims do not satisfy the audience predicate.

```bash
# Public ad-hoc channel (no pgr.subscribe row registered)
curl "http://127.0.0.1:8080/ws/_presence/_channel_lobby?apikey=$ANON_KEY"

# JWT-bound private channel
curl -H "Authorization: Bearer $JWT" http://127.0.0.1:8080/ws/_presence/room_42
```

**Response `200 OK`:**

```json
{
  "a1b2c3d4e5f6...": {"username": "jane", "cursor": {"x": 100, "y": 200}},
  "f6e5d4c3b2a1...": {"username": "bob", "status": "idle"}
}
```

Keys are auto-generated client IDs. Values are the last state each client sent.

---

## Dev-only Endpoints

### POST /api/sql

Execute raw SQL queries. Only available when `ENABLE_SQL_ENDPOINT=true` is set.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`, `Content-Type: application/json`

**Request body:**

```json
{
  "query": "SELECT * FROM pg_stat_activity"
}
```

**Response `200 OK`:** Query result rows as JSON array.

:::warning
This endpoint is intended for development and debugging only. Do not enable in production.
:::

---

## Error Format

All error responses use this format:

```json
{
  "error": "human-readable error message"
}
```

The status is conveyed only via the HTTP status code, not in the body.

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created (successful insert) |
| `204` | Success, no response body |
| `207` | Multi-Status (partial batch -- check individual results) |
| `302` | Redirect (OAuth flows) |
| `400` | Bad request (invalid parameters, constraint violation) |
| `401` | Unauthorized (missing or invalid token) |
| `403` | Forbidden (valid token but insufficient permissions, or RLS policy rejected) |
| `404` | Not found |
| `409` | Conflict (unique constraint violation) |
| `422` | Unprocessable Entity (atomic batch failed -- all rolled back) |
| `429` | Too Many Requests (auth rate limit exceeded, or per-IP WebSocket connection cap) |
| `500` | Internal server error |
| `502` | Bad Gateway (edge runtime unavailable) |
| `503` | Service Unavailable (DB disconnected, WebSocket connection limit reached, anonymous sign-in disabled, subscription/channel metadata unavailable, or Deno runtime not configured) |
