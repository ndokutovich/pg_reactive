---
title: CLI Overview
sidebar_position: 1
description: pgStack CLI — scaffold projects, manage migrations, generate types, and control your dev environment.
---

# CLI Overview

The `pgstack` CLI is a Node.js command-line tool for developing with pgStack. It scaffolds new projects, manages database migrations, generates TypeScript types, and controls your local Docker dev environment.

## Installation

The CLI is installed automatically when you scaffold a project with `npx pgstack init`. You can also install it globally:

```bash
npm install -g pgstack
# or use it via npx
npx pgstack <command>
```

## All commands

### Project scaffold

```bash
pgstack init <project-name>
```

Creates a new pgStack project directory with Docker Compose config and starter files.

### Development environment

```bash
pgstack dev            # Start Docker containers
pgstack dev stop       # Stop Docker containers
pgstack dev logs       # Tail proxy + database logs
pgstack dev status     # Show container health and ports
pgstack dev studio     # Open Studio in the browser
```

### Migrations

```bash
pgstack migration new <name>     # Create a new migration file
pgstack migration up             # Run pending migrations
pgstack migration list           # List all migrations and their status
pgstack migration rollback       # Roll back the last applied migration
```

### Database tools

```bash
pgstack db psql        # Open a psql session to the database
pgstack db reset       # Drop and recreate the database (dev only)
```

### Type generation

```bash
pgstack generate types                         # Print to stdout
pgstack generate types --output src/db.ts      # Write to file
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
