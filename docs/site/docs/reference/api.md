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

## Authentication

All endpoints (except `/health`) require an `Authorization` header:

```
Authorization: Bearer <token>
```

Token types:
- **`ANON_KEY`** — anonymous access (unauthenticated users)
- **JWT access token** — authenticated user requests
- **`SERVICE_ROLE_KEY`** — admin requests, bypasses RLS

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

### GET /auth/v1/authorize

Start an OAuth authorization flow. Redirects the browser to the provider.

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

```bash
# Examples
GET /rest/v1/todos?done=eq.false&order=created_at.desc&limit=20
GET /rest/v1/products?price=gte.10&price=lte.200&active=eq.true
GET /rest/v1/users?deleted_at=is.null
GET /rest/v1/orders?status=in.(pending,processing)
```

**Response `200 OK`:** JSON array of rows.

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

### POST /rest/v1/rpc/&#123;function&#125;

Call a PostgreSQL function.

**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request body:** Function parameters as a JSON object.

```bash
POST /rest/v1/rpc/get_order_total
{"p_order_id": 42}
```

**Response `200 OK`:** Function return value (scalar, row, or array).

**GET variant** (for read-only functions):

```bash
GET /rest/v1/rpc/get_dashboard_stats
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

**Connection confirmation** (server → client):

```json
{"type": "subscribed", "query_id": "active_orders"}
```

**Delta message** (server → client):

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

**Overflow message** (server → client, when delta > 7800 bytes):

```json
{"type": "overflow", "query_id": "active_orders", "fetch": true}
```

When overflow occurs, clear the local snapshot and re-fetch via the REST API.

**Error message** (server → client):

```json
{"type": "error", "message": "Unauthorized"}
```

---

## Error format

All error responses use this format:

```json
{
  "error": "human-readable error message",
  "status": 401
}
```

## HTTP status codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `204` | Success, no response body |
| `302` | Redirect (OAuth flows) |
| `400` | Bad request (invalid parameters, constraint violation) |
| `401` | Unauthorized (missing or invalid token) |
| `403` | Forbidden (valid token but insufficient permissions, or RLS policy rejected) |
| `404` | Not found |
| `500` | Internal server error |
