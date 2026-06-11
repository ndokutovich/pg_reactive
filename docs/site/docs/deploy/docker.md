---
title: Docker Deployment
sidebar_position: 1
description: Deploy pgStack to production using Docker Compose.
---

# Docker Deployment

pgStack is designed to run as two Docker containers managed by Docker Compose. This page covers deploying to a single server or VM using the production compose file.

## Requirements

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
- Docker Engine 24.0+ and Docker Compose Plugin
- At least 1 GB RAM (2 GB recommended)
- A domain name with DNS pointed to your server (for HTTPS)

## Initial setup

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Pull the compose file

```bash
mkdir pgstack && cd pgstack
curl -O https://raw.githubusercontent.com/ndokutovich/pg_reactive/master/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/ndokutovich/pg_reactive/master/.env.example
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in required values:

```env
# Database
POSTGRES_DB=app
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<generate with: openssl rand -base64 32>

# JWT (signing key for access tokens)
JWT_SECRET=<generate with: openssl rand -base64 32>

# API keys
ANON_KEY=<generate with: openssl rand -base64 32>
SERVICE_ROLE_KEY=<generate with: openssl rand -base64 32>

# Your app's public URL
SITE_URL=https://your-app.example.com

# At-rest encryption (edge function env vars, webhook signing secrets)
SECRETS_ENCRYPTION_KEY=<generate with: openssl rand -base64 32>
```

### 4. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

### 5. Verify

```bash
# Check containers are healthy
docker compose -f docker-compose.prod.yml ps

# Check the health endpoint
curl http://127.0.0.1:8080/health
```

## What the first boot creates

The `pgstack-postgres` image ships the pgStack bootstrap (`docker/init.sql`) in `/docker-entrypoint-initdb.d/`. On the **first** start with an empty `pgdata` volume, PostgreSQL runs it automatically and creates the security backbone: the `anon`, `authenticated`, and `service_role` roles, the `pgstack` and `auth` schemas, the auth tables (users, refresh tokens, email tokens, storage, webhooks) with RLS enabled, and default-deny grants (`EXECUTE` revoked from `PUBLIC` on all functions).

Two consequences:

- The bootstrap runs **only when the data directory is empty**. Re-running `up -d` against an existing `pgdata` volume never re-applies it.
- If you point `DATABASE_URL` at an external PostgreSQL instead of the bundled `db` service, nothing bootstraps that database. Apply the core schema yourself first — `pgstack init` scaffolds it as your first migration, or run `docker/init.sql` manually.

## Deploying with the CLI

`pgstack deploy` automates the steps above — it copies your compose file and environment file to a remote Docker host over SSH and starts the stack:

```bash
pgstack deploy --host deploy@your-server
```

| Flag | Default | Description |
|------|---------|-------------|
| `--host <user@server>` | (required) | SSH target |
| `--env <path>` | `.env.production` | Environment file to copy |
| `--compose <path>` | `docker-compose.prod.yml` | Docker Compose file to use |
| `--dir <path>` | `~/pgstack` | Remote directory for the deployment |
| `--dry-run` | — | Show what would be deployed without executing |

Run with `--dry-run` first to review the plan before anything touches the server.

## HTTPS with a reverse proxy

Never expose pgStack directly on port 80/443. Use a reverse proxy like Caddy (easiest), nginx, or Traefik.

### Caddy (recommended)

Install Caddy:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy
```

Create `/etc/caddy/Caddyfile`:

```
your-app.example.com {
    reverse_proxy 127.0.0.1:8080

    # Restrict Studio to trusted IPs (optional)
    @studio path /studio/*
    handle @studio {
        # Allow only specific IPs
        # remote_ip 1.2.3.4
        reverse_proxy 127.0.0.1:8080
    }
}
```

```bash
systemctl enable --now caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates.

### nginx

```bash
apt install nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/pgstack`:

```nginx
server {
    server_name your-app.example.com;
    listen 80;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # IMPORTANT: overwrite (not append). The default $proxy_add_x_forwarded_for
        # APPENDS the client-supplied X-Forwarded-For; a malicious client sending
        # `X-Forwarded-For: 1.2.3.4` would have that value land FIRST in the chain
        # received by the proxy. pgStack's realIP scans XFF right-to-left and
        # skips trusted-proxy hops, so it would still find the real client even
        # under the appending pattern, but overwriting with $remote_addr is the
        # less foot-gunny default.
        #
        # X-Real-IP is set for downstream apps that prefer it, but pgStack's
        # own rate limiter intentionally IGNORES X-Real-IP — it has no chain
        # to attest the source and is as spoofable as leftmost XFF. The
        # XFF-overwrite line above is what pgStack uses.
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

After enabling, also set `TRUSTED_PROXIES=<nginx-host-ip>` on the pgStack
container so it actually honours the headers. Without that env, the proxy
treats nginx as untrusted and rate-limits everyone as if they were nginx.

```bash
ln -s /etc/nginx/sites-available/pgstack /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your-app.example.com
```

### Native TLS (no reverse proxy)

pgStack can terminate TLS directly, eliminating the need for a separate reverse proxy container.

**Auto mode (Let's Encrypt):**

```yaml
proxy:
  environment:
    TLS_MODE: auto
    TLS_DOMAINS: app.example.com
    TLS_CERT_DIR: /data/certs
    TLS_ACME_EMAIL: admin@example.com
  ports:
    - "443:443"
    - "80:80"
  volumes:
    - certs:/data/certs
```

Certificates are issued and renewed automatically. Ports 80 and 443 must be publicly accessible.

**Manual mode (own certificates):**

```yaml
proxy:
  environment:
    TLS_MODE: manual
    TLS_CERT_FILE: /certs/fullchain.pem
    TLS_KEY_FILE: /certs/privkey.pem
  ports:
    - "443:443"
  volumes:
    - ./certs:/certs:ro
```

:::tip Choosing an approach
- **Reverse proxy** — best when you already have nginx/Caddy, need HTTP/2, or run multiple services on the same host
- **TLS_MODE=auto** — simplest for single-service deployments with a public domain
- **TLS_MODE=manual** — for internal CAs, self-signed certs, or environments without outbound ACME access
:::

## Running migrations in production

Use the `pgstack` CLI — it understands the `-- migrate:up` / `-- migrate:down` markers in our migration files and runs only the `up` section. **Do NOT** invoke `psql -f migration.sql` directly: psql ignores those markers and would run both sections back-to-back, leaving the database in a roll-forward-then-roll-back state.

Run migrations from your project checkout — the directory containing `pgstack.config.json` and `migrations/`. The CLI refuses to run anywhere else (`Not a pgStack project.`), so the bare `~/pgstack` directory from step 2 will not work.

The production compose file does not publish PostgreSQL on any host port (and the Firewall section below blocks 5432), so reach the database through the compose network. Either add a loopback-only mapping to the `db` service:

```yaml
db:
  ports:
    - "127.0.0.1:5432:5432"
```

then on the server, from the project checkout:

```bash
DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/app \
  pgstack migration run
```

Or from your local machine over an SSH tunnel:

```bash
ssh -L 15432:127.0.0.1:5432 user@your-server
DATABASE_URL=postgres://postgres:<password>@127.0.0.1:15432/app pgstack migration run
```

Alternatively run the CLI in a one-off Node container attached to the compose network, where `db:5432` resolves.

`pgstack migration run` is idempotent: it tracks applied migrations in a metadata table and skips ones that have already run. `pgstack migration rollback` runs the matching `-- migrate:down` section of the most recent migration (use `-n <count>` to roll back more than one, `--dry-run` to preview the SQL); useful for the rare rollback.

## Updating pgStack

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Database data is persisted in the `pgdata` Docker volume and is not affected by image updates.

## Backups

Back up the PostgreSQL data volume regularly:

The production image enforces `scram-sha-256` even for local socket connections, so pass the password from the container's own environment (and use `-T` so dump output is not CRLF-mangled by a TTY):

```bash
# Dump the database
docker compose -f docker-compose.prod.yml exec -T db bash -c 'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -U postgres app' > backup_$(date +%Y%m%d_%H%M%S).sql

# Or dump with compression
docker compose -f docker-compose.prod.yml exec -T db bash -c 'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -U postgres -Fc app' > backup_$(date +%Y%m%d_%H%M%S).dump
```

Restore from backup:

```bash
# Text dump
docker compose -f docker-compose.prod.yml exec -T db bash -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U postgres app' < backup_20250114.sql

# Custom format dump
docker compose -f docker-compose.prod.yml exec -T db bash -c 'PGPASSWORD=$POSTGRES_PASSWORD pg_restore -U postgres -d app' < backup_20250114.dump
```

Consider automating backups with a cron job and shipping them to object storage (S3, Backblaze B2, etc.).

## Resource limits

The production compose file sets resource limits:

| Service | Memory limit |
|---------|-------------|
| `db` | 1 GB |
| `proxy` | 512 MB |

Adjust in `docker-compose.prod.yml` under `deploy.resources.limits.memory`.

## Firewall

Expose only the necessary ports:

```bash
# Allow HTTPS and SSH only
ufw allow 22/tcp
ufw allow 443/tcp
ufw allow 80/tcp  # for Let's Encrypt HTTP challenge
ufw deny 5432     # PostgreSQL should NOT be public
ufw deny 8080     # pgStack proxy behind reverse proxy only
ufw enable
```
