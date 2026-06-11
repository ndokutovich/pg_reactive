---
title: pgstack dev
sidebar_position: 3
description: Start, stop, and manage the pgStack development environment.
---

# pgstack dev

`pgstack dev` and its companion commands (`stop`, `logs`, `status`, `studio`) manage your local Docker development environment.

## Commands

### Start

```bash
pgstack dev
```

Starts the PostgreSQL and proxy containers via `docker compose up -d --build --wait`. Outputs the service URLs when healthy:

```
Starting pgStack...
pgStack is running!

  PostgreSQL:  postgresql://postgres:postgres@127.0.0.1:15432/app
  Your app:    http://127.0.0.1:8080/
  REST API:    http://127.0.0.1:8080/rest/v1/
  WebSocket:   ws://127.0.0.1:8080/ws/
  Health:      http://127.0.0.1:8080/health

Run `pgstack logs` to see output, `pgstack stop` to shut down.
```

### Stop

```bash
pgstack stop
```

Stops and removes the containers (`docker compose down`). Data persists in the named `pgdata` volume.

### Logs

```bash
pgstack logs
```

Tails the logs from both containers. Press Ctrl+C to stop. To tail a single service, use Docker directly: `docker compose logs -f proxy`.

Example output:

```
db    | 2025-01-14 12:00:01 UTC [1] LOG:  database system is ready to accept connections
proxy | 2025-01-14 12:00:02 INFO pgstack_proxy: Listening on 0.0.0.0:8080
proxy | 2025-01-14 12:00:05 INFO pgstack_proxy: POST /auth/v1/signup 200 12ms
proxy | 2025-01-14 12:00:06 INFO pgstack_proxy: GET /rest/v1/todos 200 3ms
```

### Status

```bash
pgstack status
```

Shows container state, proxy health, migration status, and active live subscriptions:

```
pgStack Status

Containers:
  db  running (healthy)
  proxy  running (healthy)

Proxy health:
  healthy v0.1.0  http://127.0.0.1:8080/health

Migrations:
  All migrations applied  (3 total)

Live subscriptions:
  2 active subscriptions
```

### Studio

```bash
pgstack studio
```

Opens the Studio admin dashboard in your default browser. Accepts `--url <url>` to override the proxy base URL (default `http://127.0.0.1:8080`); opens `<url>/studio/` in the default browser.

## Rebuilding after code changes

If you've modified the PostgreSQL extension C code or the proxy source, rebuild the images:

```bash
docker compose up -d --build
```

For a full clean rebuild (after `docker system prune`):

```bash
docker compose build --no-cache db
docker compose up -d
```

## Resetting the database

To wipe all data and start fresh (development only):

```bash
pgstack db reset
```

This drops and recreates the database, runs all migrations from scratch, and runs `seed.sql` if present. Pass `--no-seed` to skip seeding:

```bash
pgstack db reset --no-seed
```

## Environment

`pgstack init` auto-generates random `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY` values into `.env` (git-ignored); only `POSTGRES_PASSWORD` defaults to `postgres`. Before exposing the proxy to a network, replace every secret listed in `.env.example` (each has an `openssl rand -base64 32` placeholder) and set `PGSTACK_ENV=production` to enable the fail-fast validator, which refuses placeholder secrets and dev-only flags.

## Port configuration

| Service | Default port | Variable |
|---------|-------------|----------|
| pgStack proxy | `8080` | `PROXY_PORT` |
| PostgreSQL | `15432` (host-side) | `PG_PORT` |

The PostgreSQL port is mapped to `15432` on the host to avoid conflicts with any local PostgreSQL installation.
