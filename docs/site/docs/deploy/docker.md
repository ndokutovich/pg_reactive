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
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

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

From your local machine, pointed at the production database:

```bash
DATABASE_URL=postgres://postgres:password@your-server:5432/app \
  pgstack migration up
```

Or shell into the server first and run the CLI there:

```bash
ssh user@your-server
cd ~/pgstack
DATABASE_URL=postgres://postgres:password@db:5432/app pgstack migration up
```

`pgstack migration` is idempotent: it tracks applied migrations in a metadata table and skips ones that have already run. `pgstack migration down` runs the matching `-- migrate:down` section of the most recent migration; useful for the rare rollback.

## Updating pgStack

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Database data is persisted in the `pgdata` Docker volume and is not affected by image updates.

## Backups

Back up the PostgreSQL data volume regularly:

```bash
# Dump the database
docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres app > backup_$(date +%Y%m%d_%H%M%S).sql

# Or dump with compression
docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres -Fc app > backup_$(date +%Y%m%d_%H%M%S).dump
```

Restore from backup:

```bash
# Text dump
docker compose -f docker-compose.prod.yml exec -T db psql -U postgres app < backup_20250114.sql

# Custom format dump
docker compose -f docker-compose.prod.yml exec -T db pg_restore -U postgres -d app < backup_20250114.dump
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
