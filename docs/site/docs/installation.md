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
# .env is generated for you with random secrets — no copy step needed
docker compose up -d
```

What gets created:

```
my-project/
├── docker-compose.yml             # All-in-one dev stack (pre-built image)
├── .env                           # Generated secrets — do not commit
├── .env.example                   # Variable reference (no secrets)
├── pgstack.config.json            # Project config (ports, schemas)
├── .gitignore
├── migrations/
│   └── 00000000000000_pgstack_init.sql  # pgStack security bootstrap
├── seed.sql                       # Optional seed data
├── public/
│   └── index.html                 # Starter page served by the proxy
└── types/                         # Output dir for `pgstack generate types`
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
| `AUTHENTICATOR_PASSWORD` | string | Login password for the powerless `authenticator` data-plane role. Random, URL-safe. Generate with `openssl rand -base64 32`. |
| `AUTHENTICATOR_ADMIN_PASSWORD` | string | Login password for the `authenticator_admin` admin-plane role (kept separate from the data plane). Random, URL-safe. |
| `JWT_SECRET` | string | Secret key for signing JWT access tokens. Must be 32+ characters. Generate with `openssl rand -base64 32`. |
| `ANON_KEY` | string | Opaque API key for anonymous (unauthenticated) requests. 32+ chars. Generate with `openssl rand -base64 32`. |
| `SERVICE_ROLE_KEY` | string | Opaque API key for service-role (admin, bypasses RLS) requests. 32+ chars. Keep secret. |
| `SECRETS_ENCRYPTION_KEY` | string | AES-256 key for at-rest encryption of edge-function env vars and webhook signing secrets. 32 raw bytes, base64-encoded. Generate with `openssl rand -base64 32`. |
| `SITE_URL` | string | Your application's public URL. Required for OAuth redirect callbacks. Example: `https://app.example.com`. |

In `PGSTACK_ENV=production` the proxy refuses to start if any secret is a publicly-known placeholder (`dev-only` / `change-me` / …) or if `ANON_KEY`/`SERVICE_ROLE_KEY` is too short. Leave the `.env.example` secrets blank and generate real values. **Email:** with `EMAIL_ENABLED=true` (default) SMTP is also required; set `EMAIL_ENABLED=false` for an email-free (e.g. OAuth-only) deployment.

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

### Email / SMTP

Email flows (verification, password reset, magic link) need SMTP. **In
`PGSTACK_ENV=production`, SMTP is required by default** (`EMAIL_ENABLED=true`).
For an email-free deployment set `EMAIL_ENABLED=false` — production boots without
SMTP and the email routes return `503`. Do not drop `PGSTACK_ENV=production` to
skip SMTP; that disables the other production guards.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENABLED` | `true` | Master switch for email flows. `false` → no SMTP required, email routes return 503. |
| `SMTP_HOST` | — | SMTP server hostname. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | — | SMTP authentication username. |
| `SMTP_PASS` | — | SMTP authentication password. |
| `SMTP_FROM` | `noreply@pgstack.local` | From address for emails sent by pgStack. |

### Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8080` | Port the proxy listens on. |
| `MAX_CONNECTIONS` | `10000` | Maximum concurrent WebSocket connections. |
| `ACCESS_TOKEN_EXPIRY_SECS` | `3600` | Access token lifetime in seconds (1 hour). |
| `REFRESH_TOKEN_EXPIRY_DAYS` | `30` | Refresh token lifetime in days. |
| `MAX_BODY_SIZE` | `1048576` | Maximum request body size in bytes (1 MB). |
| `ALLOWED_ORIGINS` | `` (strict) | CORS / WebSocket origin allow-list, comma-separated. Example: `https://app.example.com,https://admin.example.com`. Empty = strict: no `Access-Control-Allow-Origin` header is emitted; cross-origin browsers are blocked; same-origin and non-browser clients still work. |
| `ALLOW_PERMISSIVE_CORS` | `false` | When `ALLOWED_ORIGINS` is empty AND this is `true`, the proxy reflects any Origin with `Access-Control-Allow-Credentials: true` (the old dev behavior). **Never enable on a public host.** |
| `REQUIRE_AUTHENTICATED_WS` | `false` | When `true`, anon-key WebSocket subscriptions are rejected — only real JWTs (`authenticated` / `service_role`) may open `/ws/{query_id}`. Recommended whenever live queries return user-scoped data. |
| `READ_TIMEOUT` | `30` | HTTP read timeout in seconds. |
| `WRITE_TIMEOUT` | `60` | HTTP write timeout in seconds. |
| `IDLE_TIMEOUT` | `120` | HTTP keep-alive idle timeout in seconds. |
| `GZIP_LEVEL` | `5` | Gzip compression level (0=disabled, 1-9). |
| `PG_POOL_MAX_CONNS` | `50` | Max connections in the proxy's PostgreSQL pool. |
| `PG_POOL_MIN_CONNS` | `5` | Minimum idle connections kept warm. |
| `TLS_MODE` | `off` | `off` (reverse proxy), `auto` (Let's Encrypt), `manual` (own certs). |

See [Environment Variables](deploy/env-vars) for the complete list including TLS certificate settings.

### Advanced PostgreSQL

| Variable | Description |
|----------|-------------|
| `pg_reactive.max_subscriptions` | Maximum concurrent live query subscriptions (shared memory slots). Default: `1024`. Requires PostgreSQL restart. Set via `docker-compose.yml` `command:` flag. |

## Generating secrets

```bash
# JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, POSTGRES_PASSWORD, SECRETS_ENCRYPTION_KEY
openssl rand -base64 32
```

Run this five times and use each output for the respective variable.

## Verifying the installation

```bash
# Check both containers are healthy
docker compose ps

# Check the proxy responds
curl http://127.0.0.1:8080/health
# {"status":"ok","pg_connected":true}

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

In the production stack (`docker-compose.prod.yml`) and CLI-scaffolded projects, PostgreSQL data lives in the named volume `pgdata` and survives restarts and image updates. The dev source-build stack stores data on tmpfs — it is wiped on every container restart by design.

### Upgrading the PostgreSQL extension

Pulling a new image does not upgrade an already-installed extension — the installed version lives in the database (the `pgdata` volume). After updating the images, apply pending extension migrations:

```bash
docker compose exec db psql -U postgres -c "ALTER EXTENSION pg_reactive UPDATE;"
```

Check the installed version:

```bash
docker compose exec db psql -U postgres -c \
  "SELECT extversion FROM pg_extension WHERE extname = 'pg_reactive';"
```

Upgrade scripts are cumulative (for example `0.1.2 → 0.1.3 → 0.1.4`); `ALTER EXTENSION ... UPDATE` chains them automatically.
