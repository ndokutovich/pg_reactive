---
title: Environment Variables
sidebar_position: 2
description: Complete reference for all pgStack environment variables.
---

# Environment Variables

All pgStack configuration is done through environment variables. Copy `.env.example` to `.env` and fill in values before starting.

## Generating secrets

```bash
# Use this for JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, POSTGRES_PASSWORD
openssl rand -base64 32
```

Run it four times and use each output for a different secret.

## Required variables

These must be set for production. In development, the compose file provides insecure defaults.

| Variable | Example | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | `Xk8mP2nQ9r...` | PostgreSQL superuser password. Must be strong. |
| `JWT_SECRET` | `Ym3vL5wK1t...` | Signing key for JWT access tokens. Must be 32+ characters. |
| `ANON_KEY` | `Nz6xB4cJ8p...` | API key for anonymous (unauthenticated) requests. |
| `SERVICE_ROLE_KEY` | `Qr1eD7hF3a...` | Admin API key. Bypasses RLS. Keep secret. |
| `SITE_URL` | `https://app.example.com` | Public URL of your app. Required for OAuth redirects. |

## Database variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `app` | Database name. |
| `POSTGRES_USER` | `postgres` | PostgreSQL superuser username. |
| `DATABASE_URL` | *(constructed)* | Full connection string. Constructed automatically by the compose file. Override to use an external PostgreSQL instance. |

## Proxy variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `0.0.0.0:8080` | Address and port the proxy listens on. |
| `PROXY_PORT` | `8080` | Host port mapping (for `docker compose`). |
| `RUST_LOG` | `pgstack_proxy=info` | Rust log level. Set to `debug` for verbose output. |
| `ENABLE_SQL_ENDPOINT` | `false` | Enable `/api/sql` endpoint for raw SQL (dev only). **Never enable in production.** |

## Auth variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_TOKEN_EXPIRY_SECS` | `3600` | JWT access token lifetime (1 hour). |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token lifetime (30 days). |

## OAuth variables (optional)

Set these to enable social login. If not set, the corresponding provider is disabled.

| Variable | Where to get it | Description |
|----------|----------------|-------------|
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) | Google OAuth App client ID. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | Google OAuth App client secret. |
| `GITHUB_CLIENT_ID` | [GitHub Settings](https://github.com/settings/developers) | GitHub OAuth App client ID. |
| `GITHUB_CLIENT_SECRET` | GitHub Settings | GitHub OAuth App client secret. |

Redirect URI to register with OAuth providers: `https://your-app.example.com/auth/v1/callback`

## SMTP variables (optional)

Required for email verification and password reset emails. If not set, these features are disabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server hostname. Example: `smtp.sendgrid.net` |
| `SMTP_PORT` | `587` | SMTP port. Use `587` for STARTTLS, `465` for SSL, `25` for unencrypted. |
| `SMTP_USER` | — | SMTP authentication username. |
| `SMTP_PASS` | — | SMTP authentication password. |
| `SMTP_FROM` | `noreply@example.com` | From address for all auth emails. |

## CORS variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_ORIGINS` | *(empty — permissive)* | Comma-separated list of allowed CORS origins. Empty allows all origins (development). For production, set explicitly: `https://app.example.com,https://admin.example.com` |

## Edge Functions variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_RUNTIME_URL` | *(empty — disabled)* | URL of Supabase edge-runtime container. Example: `http://edge-runtime:9000`. Empty disables Deno backend. |
| `EMBEDDED_FUNCTIONS` | `false` | Enable embedded JS runtime (goja) for lightweight functions. |
| `FUNCTIONS_DIR` | `/functions` | Directory where Deno function sources are mounted. |

## Batch transaction variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_BATCH_OPERATIONS` | `20` | Maximum operations per `POST /rest/v1/batch` request. |

## Connection limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONNECTIONS` | `10000` | Maximum concurrent WebSocket connections. Each connection holds a PostgreSQL `LISTEN` session. |
| `MAX_BODY_SIZE` | `1048576` | Maximum request body size in bytes (default: 1 MB). |
| `MAX_FILE_SIZE` | `52428800` | Maximum storage upload size in bytes (default: 50 MB). |

## PostgreSQL tuning (via docker-compose command flags)

These are set as PostgreSQL GUC parameters via the `command:` field in `docker-compose.prod.yml`, not as environment variables:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pg_reactive.max_subscriptions` | `1024` | Maximum live query subscriptions (shared memory slots). Requires restart. |
| `max_connections` | `200` | PostgreSQL max client connections. |
| `shared_buffers` | `256MB` | PostgreSQL shared memory buffer. Set to 25% of RAM. |
| `effective_cache_size` | `768MB` | Estimated effective cache size. Set to 75% of RAM. |

Example in `docker-compose.prod.yml`:

```yaml
command: >
  postgres
    -c shared_preload_libraries=pg_reactive
    -c pg_reactive.max_subscriptions=4096
    -c max_connections=300
    -c shared_buffers=512MB
    -c effective_cache_size=1536MB
    -c log_min_messages=warning
    -c log_statement=none
```

## Environment variable precedence

1. Variables explicitly set in the shell environment
2. Variables in `.env` file (loaded by docker compose)
3. Default values in `docker-compose.yml`

## Security checklist

Before going to production:

- [ ] `POSTGRES_PASSWORD` is a strong random value (not the `.env.example` default)
- [ ] `JWT_SECRET` is a strong random value (32+ characters)
- [ ] `ANON_KEY` is a strong random value
- [ ] `SERVICE_ROLE_KEY` is a strong random value, treated like a database password
- [ ] `ENABLE_SQL_ENDPOINT` is `false` or unset
- [ ] `ALLOWED_ORIGINS` is set to your specific domain(s)
- [ ] `SITE_URL` is set to your production URL
- [ ] `.env` is in `.gitignore` (never committed)
- [ ] PostgreSQL port (`5432`) is not exposed to the internet
