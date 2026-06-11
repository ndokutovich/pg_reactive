---
title: Install
sidebar_position: 2
description: Build pg_reactive from source and load it into a stock PostgreSQL server — no Docker, proxy, or SDK required.
---

# Install

`pg_reactive` is a plain PostgreSQL C extension. It builds with PGXS, loads
through `shared_preload_libraries`, and exposes everything through the `pgr`
schema once you run `CREATE EXTENSION`. There is **no daemon, no replication
slot, no external coordinator** — a `LISTEN pgr` from any libpq client is the
entire delivery mechanism.

This page is the from-source path for a Postgres user who just wants the
extension. The [Go proxy](./proxy.md), the [SDK](./sdk.md), and Docker are all
optional layers on top — skip them entirely if you only need server-side live
queries driven by `LISTEN`/`NOTIFY`.

If you would rather not compile anything, jump to
[All-in-one Docker](#all-in-one-docker) or use
[pgStack](/quickstart), the batteries-included umbrella that bundles the
extension, proxy, auth, and REST for you.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **PostgreSQL 16 or newer** | Both the running server and its development headers. |
| **`pg_config` on `$PATH`** | The PGXS build reads it to locate headers, libs, and the install paths. It ships in the `-dev` / `-devel` package. |
| **A C toolchain** | `gcc` or `clang`, plus `make`. |

On Debian/Ubuntu the dev headers and toolchain are:

```bash
sudo apt-get install -y postgresql-server-dev-16 build-essential
```

On RHEL/Fedora the equivalent is `postgresql16-devel` plus `gcc make`.

Confirm `pg_config` resolves to the **16+** install you intend to build against —
the build links against whatever `pg_config` points at:

```bash
pg_config --version    # expect: PostgreSQL 16.x (or newer)
```

## Build from source

Clone the repo and build inside `ext/`. The [`Makefile`](https://github.com/ndokutovich/pg_reactive)
is a standard PGXS makefile: `MODULE_big = pg_reactive` links the five C
objects (`pg_reactive.o`, `dependency.o`, `invalidation.o`, `recompute.o`,
`bgworker.o`) into one shared library, and `include $(PGXS)` pulls the PostgreSQL
build rules so `make` and `make install` resolve headers and install paths
through `pg_config` automatically.

```bash
git clone https://github.com/ndokutovich/pg_reactive.git
cd pg_reactive/ext
make
sudo make install
```

`sudo make install` copies the shared library into the server's `$libdir` and
the SQL/control files into `SHAREDIR/extension/`. If you own those directories
(e.g. a per-user PostgreSQL build), plain `make install` without `sudo` works.

To build against a PostgreSQL that is not first on your `PATH`, point PGXS at the
right `pg_config`:

```bash
make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
sudo make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config install
```

The build compiles with `-Wall -Werror`, so any warning is a hard failure — a
clean `make` means a clean library.

## Load the library

`pg_reactive` registers shared memory and hooks at postmaster start, so it
**must** be in `shared_preload_libraries`. Add it to `postgresql.conf`:

```ini
# postgresql.conf
shared_preload_libraries = 'pg_reactive'
```

### Set the restart-only GUCs

Three of the five GUCs are `PGC_POSTMASTER` — they are read once at server start
and can only be changed by editing `postgresql.conf` (or passing `-c` flags) and
**restarting**. Set the ones you need alongside the preload line:

```ini
# postgresql.conf
shared_preload_libraries        = 'pg_reactive'
pg_reactive.max_subscriptions   = 1024        # shared-memory subscription slots
pg_reactive.async_recompute     = off         # optional background-worker recompute
pg_reactive.database            = postgres    # DB the async worker connects to
```

`max_subscriptions` sizes the shared-memory hash that holds your live queries —
1024 slots by default. `async_recompute` (default `off`, fine for most
workloads) and `database` only matter if you enable the optional background
worker. The two runtime-tunable GUCs — `pg_reactive.batch_invalidation` and
`pg_reactive.notify_channel` — are `PGC_SUSET` and need no restart; see
[GUCs](./gucs.md) for the full table.

:::warning Containers on tmpfs: use `-c` flags, not `ALTER SYSTEM`
`ALTER SYSTEM SET pg_reactive.max_subscriptions = …` writes to
`postgresql.auto.conf` in the data directory. If your data directory lives on
**tmpfs** (the dev Docker setup runs PG data on tmpfs so it is ephemeral), that
file is wiped on every container restart and your setting silently reverts to the
default. In a container, pass `PGC_POSTMASTER` GUCs through the compose
`command:` instead, where they are reapplied at every boot:

```yaml
# docker-compose.yml (db service)
command:
  - postgres
  - -c
  - shared_preload_libraries=pg_reactive
  - -c
  - pg_reactive.max_subscriptions=1024
```
:::

### Restart PostgreSQL

Because `shared_preload_libraries` and the `PGC_POSTMASTER` GUCs are read at
postmaster start, a reload is not enough — restart the server:

```bash
sudo systemctl restart postgresql    # or: pg_ctl restart -D <datadir>
```

## Create the extension

With the library preloaded, create the extension in each database that needs live
queries:

```sql
CREATE EXTENSION pg_reactive;
```

This runs the install script, which **creates the `pgr` schema itself** and
installs every function (`pgr.subscribe`, `pgr.unsubscribe`,
`pgr.get_subscriptions`, `pgr.restore_subscriptions`, `pgr.stats`) into it.

:::note Why the control file has no `schema =`
`pg_reactive.control` deliberately omits a `schema =` line. The install script
creates the `pgr` schema and its objects explicitly; declaring `schema = pgr` in
the control file as well would make PostgreSQL try to create the schema a second
time and the install would fail. (`pgr` is used rather than `pg_reactive`
because the `pg_` prefix is reserved for system schemas.) Leave the control file
alone.
:::

All `pgr` functions are `REVOKE`d from `PUBLIC` by default. As a superuser
you can call them straight away; to let an application role manage or inspect
subscriptions, `GRANT EXECUTE` explicitly. See the [security model](./security-model.md)
for the safe way to expose subscription registration to untrusted clients.

## Smoke test

Verify the install end to end with a tiny query, an INSERT, and a `LISTEN`. Run
this in `psql`:

```sql
-- A table to watch.
CREATE TABLE orders (
    id          serial PRIMARY KEY,
    customer_id int,
    total       numeric,
    status      text
);

-- Subscribe to a live query under a stable id.
SELECT pgr.subscribe('orders_active', $$
    SELECT id, customer_id, total, status
    FROM orders
    WHERE status IN ('open', 'pending')
$$);

-- Listen on the default channel.
LISTEN pgr;

-- This INSERT matches the query — it should fire a delta.
INSERT INTO orders (customer_id, total, status) VALUES (42, 99.99, 'open');
```

In `psql`, the asynchronous notification is printed after the next command (psql
checks for notifications between statements). A no-op nudges it out:

```sql
SELECT 1;
```

```text
Asynchronous notification "pgr" with payload
"{"query_id":"orders_active","seq":1,"inserted":[{"id":1,"customer_id":42,"total":99.99,"status":"open"}],"deleted":[]}"
received from server process with PID ...
```

Seeing that `inserted` delta means the extension is live: `pgr.subscribe`
registered the dependency, the AFTER STATEMENT trigger fired, and the delta went
out on the `pgr` channel. The [wire format](./wire-format.md) page documents
every message shape (`delta`, `overflow`, `invalidated`). Clean up when you are
done:

```sql
SELECT pgr.unsubscribe('orders_active');
```

:::tip Snapshots are ephemeral — restore after a restart
Live-query snapshots live in `UNLOGGED` tables and the dependency hash lives in
shared memory, so **both are wiped on every server restart**. The durable record
of your subscriptions persists in `pgr.persisted_subscriptions`, but the
in-memory state has to be rebuilt. Run this once per database after a restart to
bring live queries back:

```sql
SELECT pgr.restore_subscriptions();
```

Until you do, subscribed queries emit no deltas. The all-in-one image runs this
for you on boot.
:::

## All-in-one Docker

If you want PostgreSQL + the extension + the Go proxy in **one container**
without compiling anything on your host, use the canonical all-in-one image. It
is built from [`docker/Dockerfile.all-in-one`](https://github.com/ndokutovich/pg_reactive):
the build compiles and `make install`s the extension into a `postgres:16-bookworm`
base, drops in the prebuilt `pgstack-proxy`, and ships an entrypoint that starts
PostgreSQL, runs `pgr.restore_subscriptions()` for every database with the
extension, then starts the proxy as the lifecycle leader.

Build it from the repo root (the build context is the whole repo):

```bash
docker build -f docker/Dockerfile.all-in-one -t pgstack-all-in-one .
```

`PGC_POSTMASTER` GUCs are forwarded to `postgres` through the compose
`command:` — the entrypoint passes `$@` straight to `postgres`:

```yaml
services:
  pgr:
    image: pgstack-all-in-one
    ports:
      - "127.0.0.1:5432:5432"   # PostgreSQL
      - "127.0.0.1:8080:8080"   # WebSocket proxy
    command:
      - -c
      - shared_preload_libraries=pg_reactive
      - -c
      - pg_reactive.max_subscriptions=1024
```

For deployment-specific setup (migrations, seed SQL, edge-function
registration), ship an executable `/app/post-init.sh` — the entrypoint runs it
after PostgreSQL is ready and before the proxy starts.

## Where to go next

- [Subscribe](./subscribe.md) — the `pgr.subscribe` / `pgr.unsubscribe` API and `delta` vs `notify` modes.
- [Query support](./query-support.md) — which `SELECT` shapes are tracked.
- [GUCs](./gucs.md) — the complete five-parameter configuration reference.
- [Proxy](./proxy.md) — fan deltas out to browsers over WebSocket.
- For the full backend stack (auth, REST, RLS, Studio), start at the [pgStack quickstart](/quickstart).
