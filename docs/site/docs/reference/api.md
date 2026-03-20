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
| `POST` | `/auth/v1/signup` | apikey | Register new user |
| `POST` | `/auth/v1/token?grant_type=password` | apikey | Sign in with email/password |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | apikey | Refresh access token |
| `GET` | `/auth/v1/user` | JWT | Get current user profile |
| `PATCH` | `/auth/v1/user` | JWT | Update current user |
| `POST` | `/auth/v1/logout` | JWT | Sign out, invalidate refresh token |
| `POST` | `/auth/v1/recover` | apikey | Send password recovery email |
| `POST` | `/auth/v1/recover/confirm` | None | Confirm password reset with token |
| `POST` | `/auth/v1/magiclink` | apikey | Send magic link email |
| `GET` | `/auth/v1/magiclink/verify` | None | Verify magic link token |
| `GET` | `/auth/v1/verify` | None | Verify email confirmation token |
| `GET` | `/auth/v1/authorize?provider={name}` | None | Start OAuth flow (google, github) |
| `GET` | `/auth/v1/callback` | None | OAuth callback (internal) |

### Auth Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/auth/v1/admin/users` | service_role | List all users |
| `POST` | `/auth/v1/admin/users` | service_role | Create a user |
| `DELETE` | `/auth/v1/admin/users/{id}` | service_role | Delete a user |

### REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
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

### WebSocket

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ws/{query_id}` | None/JWT | Live query WebSocket connection |

### Dev-only

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/sql` | service_role | Execute raw SQL (requires `ENABLE_SQL_ENDPOINT=true`) |

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
  "version": "0.1.1"
}
```

---

## Authentication Endpoints

### POST /auth/v1/signup

Register a new user with email and password.

**Headers:** `Authorization: Bearer <ANON_KEY>`

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "strongpassword123",
  "data": { "full_name": "Jane Doe" }
}
```

`data` is optional — stored as `user_metadata`.

**Response `200 OK`:**

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

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | `invalid_request` | Missing email or password |
| `400` | `email_already_exists` | Email already registered |
| `400` | `password_too_short` | Password < 8 characters |

---

### POST /auth/v1/token

Sign in or refresh tokens.

**Headers:** `Authorization: Bearer <ANON_KEY>`

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
| `401` | `invalid_credentials` | Wrong email or password |

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
| `401` | `invalid_refresh_token` | Refresh token not found or expired |

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

**Headers:** `Authorization: Bearer <ANON_KEY>`

**Request body:**

```json
{
  "email": "user@example.com"
}
```

**Response `200 OK`:**

```json
{
  "message": "Recovery email sent"
}
```

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

**Response `200 OK`:** New token pair (same format as sign-in response).

**Errors:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | `invalid_token` | Token expired or already used |
| `400` | `password_too_short` | Password < 8 characters |

---

### POST /auth/v1/magiclink

Send a magic link email for passwordless sign-in.

**Headers:** `Authorization: Bearer <ANON_KEY>`

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

**Response `200 OK`:** Token pair (same format as sign-in response).

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
| `provider` | Yes | `google` or `github` |
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
  "data": { "full_name": "New User" }
}
```

**Response `200 OK`:** Created user object.

---

### DELETE /auth/v1/admin/users/&#123;id&#125;

Delete a user by ID.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

```bash
DELETE /auth/v1/admin/users/550e8400-e29b-41d4-a716-446655440000
```

**Response `200 OK`:** Deleted user object.

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
| `limit` | Max rows to return (default: 1000) |
| `offset` | Skip N rows |

**Filter operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`

**Logical combinators:** `or=(col1.eq.val1,col2.eq.val2)`, `and=(col1.gt.0,col1.lt.100)`

**Prefer header for count:**

| Header | Description |
|--------|-------------|
| `Prefer: count=exact` | Include total row count in `Content-Range` response header |

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

**Response `200 OK`:** Inserted row(s).

#### Upsert

Add header `Prefer: resolution=merge-duplicates` and query param `on_conflict=column`:

```bash
POST /rest/v1/products?on_conflict=sku
Prefer: resolution=merge-duplicates
```

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

**Response `200 OK`:**

```json
{
  "name": "avatars"
}
```

---

### GET /storage/v1/bucket

List all storage buckets.

**Headers:** `Authorization: Bearer <token>`

**Response `200 OK`:**

```json
[
  { "id": "avatars", "name": "avatars", "public": false, "created_at": "2025-01-14T12:00:00Z" },
  { "id": "uploads", "name": "uploads", "public": true, "created_at": "2025-01-14T12:00:00Z" }
]
```

---

### DELETE /storage/v1/bucket/&#123;bucketId&#125;

Delete a storage bucket. The bucket must be empty.

**Headers:** `Authorization: Bearer <SERVICE_ROLE_KEY>`

```bash
DELETE /storage/v1/bucket/avatars
```

**Response `200 OK`:** Deleted bucket object.

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
  "Key": "avatars/users/123/photo.png"
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
| `limit` | Max objects to return |
| `offset` | Skip N objects |

```bash
GET /storage/v1/object/list/avatars?prefix=users/123/&limit=20
```

**Response `200 OK`:** Array of object metadata.

```json
[
  { "name": "photo.png", "id": "uuid", "metadata": { "size": 12345, "mimetype": "image/png" } }
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

**Response `200 OK`:** Deleted object metadata.

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
  "inserted": [
    {"id": 42, "status": "pending", "amount": 149.99}
  ],
  "deleted": [
    {"id": 37, "status": "pending", "amount": 29.99}
  ]
}
```

**Overflow message** (server to client, when delta > 7800 bytes):

```json
{"type": "overflow", "query_id": "active_orders", "fetch": true}
```

When overflow occurs, clear the local snapshot and re-fetch via the REST API.

**Error message** (server to client):

```json
{"type": "error", "message": "Unauthorized"}
```

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
  "error": "human-readable error message",
  "status": 401
}
```

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
| `500` | Internal server error |
| `502` | Bad Gateway (edge runtime unavailable) |
