---
title: Database Branching
sidebar_position: 6
description: Create isolated database branches for parallel development and safe migration testing.
---

# Database Branching

Database branching creates a full copy of your database using PostgreSQL's native `CREATE DATABASE ... TEMPLATE`. Each branch is an independent database — test migrations, seed different data, or develop features in isolation without affecting the main database.

## Create a branch

```bash
pgstack db branch my-feature
```

This creates a new database `my-feature` as a clone of your current database. The operation is instant on copy-on-write filesystems and fast on all others.

## Switch to a branch

```bash
pgstack db checkout my-feature
```

Updates `DATABASE_URL` in your project's `.env` file to point to the branch database. Restart the proxy after switching:

```bash
docker compose up -d proxy
```

## Delete a branch

```bash
pgstack db branch --delete my-feature
```

Drops the branch database. Active connections are terminated first.

## Workflow example

```bash
# Start from the main database
pgstack db branch try-new-schema

# Switch to the branch
pgstack db checkout try-new-schema

# Test a risky migration
pgstack migration up

# If it breaks, just delete the branch and start over
pgstack db checkout myapp
pgstack db branch --delete try-new-schema
```

## How it works

Under the hood, `pgstack db branch` runs:

```sql
CREATE DATABASE "my-feature" TEMPLATE "myapp"
```

PostgreSQL's `TEMPLATE` mechanism copies the entire database — schema, data, indexes, sequences, and extensions. The source database must have no active connections during the clone (the CLI terminates them automatically).

## Naming rules

Branch names are sanitized to valid PostgreSQL identifiers. Only alphanumeric characters, underscores, and hyphens are allowed. Invalid characters are stripped:

```bash
pgstack db branch feat/login    # creates database "featlogin"
pgstack db branch my_feature    # creates database "my_feature"
pgstack db branch v2.0-beta     # creates database "v20-beta"
```

## Limitations

- Branches are full database copies, not incremental snapshots. Large databases take more time and disk space.
- The source database must have no active connections during cloning. The CLI handles this automatically, but it means a brief interruption for connected clients.
- Branches are local to the PostgreSQL instance. They are not synced to other environments.
