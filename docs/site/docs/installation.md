---
title: Installation
sidebar_position: 3
description: All installation options for pgStack — Docker Compose, CLI scaffold, and manual setup.
---

# Installation

## Option 1: CLI scaffold (recommended)

The `pgstack` CLI scaffolds a new project with Docker Compose, an `.env` file, and an initial migration directory.

```bash
npx pgstack init my-project
cd my-project
cp .env.example .env
# Edit .env with your secrets
docker compose up -d
```

What gets created:

```
my-project/
├── docker-compose.yml       # Two-container dev stack
├── docker-compose.prod.yml  # Production stack (pre-built images)
├── .env.example             # Variable reference
├── migrations/
│   └── 00001_init.sql       # Starter migration
└── package.json             # pgstack CLI dev dependency
```

## Option 2: Docker Compose from source

Clone the repository and run the dev stack:

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive
cp .env.example .env
docker compose up -d --build
```

The `--build` flag compiles the PostgreSQL extension and the proxy from source. This takes 2-5 minutes the first time. Subsequent builds are cached.

## Option 3: Pre-built images (production)

Use the production compose file with pre-built images from GitHub Container Registry:

```bash
curl -O https://raw.githubusercontent.com/ndokutovich/pg_reactive/master/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/ndokutovich/pg_reactive/master/.env.example
cp .env.example .env
# Fill in all required secrets (see below)
docker compose -f docker-compose.prod.yml up -d
```

## System requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| RAM | 512 MB | 2 GB |
| CPU | 1 core | 2+ cores |
| Disk | 1 GB | 10 GB+ |
| Docker | 20.10+ | latest |
| Node.js (CLI only) | 18.0+ | 20 LTS |

## Environment variables

Copy `.env.example` to `.env` and fill in the values before starting in production.

### Required for production

| Variable | Type | Description |
|----------|------|-------------|
| `POSTGRES_PASSWORD` | string | PostgreSQL superuser password. Use a strong random value. |
| `JWT_SECRET` | string | Secret key for signing JWT access tokens. Must be 32+ characters. Generate with `openssl rand -base64 32`. |
| `ANON_KEY` | string | Opaque API key for anonymous (unauthenticated) requests. Generate with `openssl rand -base64 32`. |
| `SERVICE_ROLE_KEY` | string | Opaque API key for service-role (admin, bypasses RLS) requests. Keep secret. |
| `SITE_URL` | string | Your application's public URL. Required for OAuth redirect callbacks. Example: `https://app.example.com`. |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `app` | Database name. |
| `POSTGRES_USER` | `postgres` | PostgreSQL superuser username. |

### OAuth providers (optional)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID from [Google Cloud Console](https://console.cloud.google.com/apis/credentials). |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID from [GitHub Settings](https://github.com/settings/developers). |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret. |

### SMTP / email (optional)

Required for email verification and magic links.

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | — | SMTP server hostname. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | — | SMTP authentication username. |
| `SMTP_PASS` | — | SMTP authentication password. |
| `SMTP_FROM` | `noreply@example.com` | From address for emails sent by pgStack. |

### Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8080` | Port the proxy listens on. |
| `MAX_CONNECTIONS` | `10000` | Maximum concurrent WebSocket connections. |
| `ACCESS_TOKEN_EXPIRY_SECS` | `3600` | Access token lifetime in seconds (1 hour). |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token lifetime in days. |
| `MAX_BODY_SIZE` | `1048576` | Maximum request body size in bytes (1 MB). |
| `ALLOWED_ORIGINS` | `` (permissive) | CORS allowed origins, comma-separated. Example: `https://app.example.com`. Empty = all origins allowed (dev only). |
| `READ_TIMEOUT` | `30` | HTTP read timeout in seconds. |
| `WRITE_TIMEOUT` | `60` | HTTP write timeout in seconds. |
| `IDLE_TIMEOUT` | `120` | HTTP keep-alive idle timeout in seconds. |
| `GZIP_LEVEL` | `5` | Gzip compression level (0=disabled, 1-9). |
| `PG_POOL_MAX_CONNS` | `50` | Max connections in the proxy's PostgreSQL pool. |
| `PG_POOL_MIN_CONNS` | `5` | Minimum idle connections kept warm. |
| `TLS_MODE` | `off` | `off` (reverse proxy), `auto` (Let's Encrypt), `manual` (own certs). |

See [Environment Variables](/docs/deploy/env-vars) for the complete list including TLS certificate settings.

### Advanced PostgreSQL

| Variable | Description |
|----------|-------------|
| `pg_reactive.max_subscriptions` | Maximum concurrent live query subscriptions (shared memory slots). Default: `1024`. Requires PostgreSQL restart. Set via `docker-compose.yml` `command:` flag. |

## Generating secrets

```bash
# JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, POSTGRES_PASSWORD
openssl rand -base64 32
```

Run this four times and use each output for the respective variable.

## Verifying the installation

```bash
# Check both containers are healthy
docker compose ps

# Check the proxy responds
curl http://127.0.0.1:8080/health
# {"status":"ok","version":"0.1.0"}

# Check PostgreSQL is running
docker compose exec db psql -U postgres -c "SELECT version();"
```

## Updating pgStack

### Dev (source build)

```bash
git pull
docker compose up -d --build
```

### Production (pre-built images)

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The database data is stored in a named Docker volume (`pgdata`) and is preserved across container restarts and image updates.
