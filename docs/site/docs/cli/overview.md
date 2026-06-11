---
title: CLI Overview
sidebar_position: 1
description: pgStack CLI — scaffold projects, manage migrations, generate types, and control your dev environment.
---

# CLI Overview

The `pgstack` CLI is a Node.js command-line tool for developing with pgStack. It scaffolds new projects, manages database migrations, generates TypeScript types, and controls your local Docker dev environment.

## Installation

No project-local install is needed — run the CLI via `npx pgstack <command>`, or install it globally:

```bash
npm install -g pgstack
# or use it via npx
npx pgstack <command>
```

## Global options

These flags work on every command. The CLI propagates them to subcommands via environment variables, so you can also set the variable directly:

| Flag | Env var | Description |
|------|---------|-------------|
| `-v, --version` | — | Print the CLI version and exit |
| `--verbose` | `PGSTACK_VERBOSE=1` | Enable verbose diagnostic output |
| `--url <url>` | `PGSTACK_URL` | pgStack proxy URL (the flag overrides the env var) |
| `--json` | `PGSTACK_JSON=1` | Output results as JSON — useful for scripting and CI |

```bash
pgstack --json status
pgstack --url http://127.0.0.1:9090 functions list
```

## All commands

### Project scaffold

```bash
pgstack init <project-name>
```

Creates a new pgStack project directory with Docker Compose config and starter files.

### Development environment

```bash
pgstack dev       # Start Docker containers
pgstack stop      # Stop Docker containers
pgstack logs      # Tail proxy + database logs
pgstack status    # Show container health, proxy health, migrations, subscriptions
pgstack studio    # Open Studio in the browser
```

### Migrations

```bash
pgstack migration create <name>  # Create a new migration file
pgstack migration run            # Run pending migrations
pgstack migration status         # List all migrations and their status
pgstack migration rollback       # Roll back the last applied migration
```

### Database tools

```bash
pgstack db shell                     # Open a psql session to the database
pgstack db reset                     # Drop and recreate the database (dev only)
pgstack db seed                      # Run seed.sql
pgstack db branch <name>             # Create a database branch (clone via TEMPLATE)
pgstack db branch --delete <name>    # Delete a database branch
pgstack db checkout <name>           # Switch DATABASE_URL to a branch database
```

Database branching creates a full copy of your database using PostgreSQL's `CREATE DATABASE ... TEMPLATE`. Each branch is an independent database — you can test migrations, seed different data, or develop features in isolation without affecting the main database.

### Type generation

```bash
pgstack generate types                         # Write to types/database.ts (default)
pgstack generate types --output src/db.ts      # Write to file
```

### Edge Functions

```bash
pgstack functions new <name>                   # Scaffold a new function
pgstack functions deploy <name>                # Register/update a function
pgstack functions list                         # List all registered functions
pgstack functions delete <name>                # Deactivate a function
pgstack functions serve                        # Watch supabase/functions/ and hot-reload on change
```

### Job queue

```bash
pgstack dbos status          # Show job queue status (count by status)
pgstack dbos retry <id>      # Retry a failed job (reset to pending)
pgstack dbos cancel <id>     # Cancel a pending or running job
```

### Deployment

```bash
pgstack deploy --host <user@server>   # Deploy pgStack to a remote Docker host via SSH
```

## Help

Every command supports `--help`:

```bash
pgstack --help
pgstack migration --help
pgstack generate --help
```

## Next steps

- [init](./init) — scaffolding a new project
- [dev](./dev) — managing the development environment
- [migrations](./migrations) — database migration workflow
- [generate](./generate) — TypeScript type generation
- [db branching](./db-branching) — database branching workflow
