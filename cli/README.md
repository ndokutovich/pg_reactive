# pgstack

Postgres-native backend platform. One PostgreSQL, zero extra containers: REST,
auth, realtime, storage and edge functions served from a single thin proxy in
front of your database.

## Install

```bash
npm install -g pgstack
```

## Quick start

```bash
pgstack init my-app     # scaffold a project (compose file, migrations, .env)
cd my-app
pgstack dev             # start PostgreSQL + the proxy
```

Then open the Studio at the URL `pgstack dev` prints.

## Commands

| Command | What it does |
|---|---|
| `pgstack init` | Create a new project |
| `pgstack dev` | Start PostgreSQL and the proxy locally |
| `pgstack deploy` | Deploy to a remote Docker host over SSH |
| `pgstack migration` | Create, apply and roll back migrations |
| `pgstack functions` | Manage edge functions |
| `pgstack db` | Database management |
| `pgstack studio` | Open the Studio UI |
| `pgstack generate` | Code generation |
| `pgstack dbos` | Durable job queue |
| `pgstack shell` | Open a psql shell against the project database |

Run any command with `--help` for its options.

## Configuration

Copy `.env.example` to `.env` and fill in the generated secrets. In
`PGSTACK_ENV=production` the proxy refuses to boot with placeholder values,
short keys, or a missing SMTP configuration.

## Links

- Documentation: https://pgstack.org
- Source: https://github.com/ndokutovich/pg_reactive/tree/master/cli
- Issues: https://github.com/ndokutovich/pg_reactive/issues

## License

Apache-2.0
