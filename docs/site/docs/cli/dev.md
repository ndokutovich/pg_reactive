---
title: pgstack dev
sidebar_position: 3
description: Start, stop, and manage the pgStack development environment.
---

# pgstack dev

The `pgstack dev` command group manages your local Docker development environment.

## Commands

### Start

```bash
pgstack dev
# or
pgstack dev start
```

Starts the PostgreSQL and proxy containers via `docker compose up -d`. Outputs the service URLs when healthy:

```
Starting pgStack dev environment...

  Database:  postgresql://postgres:postgres@127.0.0.1:15432/app
  API:       http://127.0.0.1:8080
  Studio:    http://127.0.0.1:8080/studio/

Both services are healthy.
```

### Stop

```bash
pgstack dev stop
```

Stops the containers (`docker compose stop`). Data is preserved in the Docker volume.

### Logs

```bash
pgstack dev logs
```

Tails the logs from both containers. Press Ctrl+C to stop.

```bash
# Logs from a specific service
pgstack dev logs --service proxy
pgstack dev logs --service db
```

Example output:

```
db    | 2025-01-14 12:00:01 UTC [1] LOG:  database system is ready to accept connections
proxy | 2025-01-14 12:00:02 INFO pgstack_proxy: Listening on 0.0.0.0:8080
proxy | 2025-01-14 12:00:05 INFO pgstack_proxy: POST /auth/v1/signup 200 12ms
proxy | 2025-01-14 12:00:06 INFO pgstack_proxy: GET /rest/v1/todos 200 3ms
```

### Status

```bash
pgstack dev status
```

Shows the running state and health of each container:

```
Service   Status    Health    Port
db        running   healthy   127.0.0.1:15432 → 5432
proxy     running   healthy   127.0.0.1:8080 → 8080
```

### Studio

```bash
pgstack dev studio
```

Opens the Studio admin dashboard in your default browser.

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

This drops and recreates the database, then runs all migrations from scratch.

## Environment

The dev environment uses hardcoded development secrets (clearly marked as dev-only in the `.env.example`). Never use development containers in production. Use `docker-compose.prod.yml` with proper secrets for production.

## Port configuration

| Service | Default port | Variable |
|---------|-------------|----------|
| pgStack proxy | `8080` | `PROXY_PORT` |
| PostgreSQL | `15432` (host-side) | — |

The PostgreSQL port is mapped to `15432` on the host to avoid conflicts with any local PostgreSQL installation.
