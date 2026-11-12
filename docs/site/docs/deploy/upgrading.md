---
title: Upgrading
sidebar_position: 4
description: How to move a running pgStack to a newer release, and how to find out that you should.
---

# Upgrading

pgStack ships through four channels and each one updates differently. Most
confusion comes from updating one and expecting another to follow.

| What you run | What updates it |
|---|---|
| `pgstack-proxy`, `pgstack-all-in-one` (containers) | a new image, `docker compose pull` |
| `pgstack-postgres` (the image with the extension inside) | a new image, plus `ALTER EXTENSION` if the extension version changed |
| `pg_reactive` from PGXN, in your own cluster | `pgxn install` + `ALTER EXTENSION` |
| `@pgstack/sdk`, `pgstack` (npm) | `npm install` — these are clients, they ship no server code |

## Find out what you are running

```bash
# containers: what image tags the project actually uses
docker compose config | grep 'image:'

# the proxy's build, straight from the running container
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "$(docker compose ps -q proxy-go)"

# the extension, from inside the database
docker compose exec -T db psql -U postgres -d app \
  -c "SELECT extversion FROM pg_extension WHERE extname = 'pg_reactive'"

# npm clients
npm ls @pgstack/sdk
```

## Update the containers

Unpinned (the tag is `latest`, `0.3`, or a branch of your own):

```bash
docker compose pull
docker compose up -d
```

Compose recreates only the containers whose image changed.

**Pinned to a version** — and for a deployment you keep, pinning is the right
call — `pull` changes nothing. Move the tag first:

```bash
sed -i 's/pgstack-proxy:0.3.4/pgstack-proxy:0.3.5/' docker-compose.prod.yml
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

This is the trade you are making: pinning protects you from surprise changes
and leaves you responsible for reading release notes.

## Update the extension

Only needed when the release notes say the **extension** version moved, not the
platform version. The extension and pgStack version independently (extension
`0.1.8` alongside platform `0.3.5`), because the extension has its own release
cadence and its own license.

```bash
pgxn install pg_reactive
```

```sql doc-test:skip=requires an installed extension and a real upgrade path
ALTER EXTENSION pg_reactive UPDATE;
SELECT extversion FROM pg_extension WHERE extname = 'pg_reactive';
```

Upgrade scripts chain, so a cluster on any earlier version reaches current in
one statement. The extension does **not** reload on a normal server restart —
`shared_preload_libraries` picks up the new `.so` only when PostgreSQL restarts:

```bash
docker compose restart db     # or: pg_ctl restart
```

**In the bundled images the extension ships inside the image**, so pulling a new
`pgstack-postgres` and restarting it does both steps at once. Your data lives in
the volume, not the image.

## Update the clients

```bash
npm install @pgstack/sdk@latest        # in your app
npm install -g pgstack@latest          # the CLI
```

Clients are compatible across the minor line; a proxy upgrade does not require
an SDK upgrade unless the release notes say so.

## Rollback

Images are immutable and tagged, so rolling back is moving the tag back and
recreating the containers:

```bash
docker compose down
docker compose up -d          # with the previous tag in the compose file
```

The database volume is untouched by an image rollback. **An extension upgrade is
not reversible** — `ALTER EXTENSION ... UPDATE` has no downgrade path. Back up
before upgrading a database you cannot recreate.

## How to find out that you should upgrade

- **Watch the repository's releases.** Security-relevant releases say so in the
  title and in the release body.
- **GitHub security advisories** for this repository appear in the same place
  and are what Dependabot reads.
- There is no push notification channel for container consumers: registries do
  not alert on a CVE in an image you pull manually. Watching releases is the
  mechanism.
