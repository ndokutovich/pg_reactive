---
title: Configuration (GUCs)
sidebar_position: 6
description: The five pg_reactive GUC parameters, their contexts and defaults, and how to set the restart-only ones.
---

# Configuration (GUCs)

pg_reactive exposes exactly **five** configuration parameters. They are
standard PostgreSQL GUCs (Grand Unified Configuration variables), defined
in the extension's C source (`ext/src/pg_reactive.c`) via
`DefineCustom*Variable`. There are no others — anything outside this list
is not a pg_reactive setting.

Two of the five are runtime-settable by a superuser; the other three are
`PGC_POSTMASTER` and only take effect at server start.

## All five parameters

| Parameter | Context | Default | Description |
|-----------|---------|--------:|-------------|
| `pg_reactive.max_subscriptions` | `PGC_POSTMASTER` | `1024` | Number of shared-memory subscription slots. Restart required. |
| `pg_reactive.async_recompute` | `PGC_POSTMASTER` | `off` | Enable the background worker that runs delta recompute asynchronously instead of inline in DML triggers. Restart required. |
| `pg_reactive.database` | `PGC_POSTMASTER` | `postgres` | Database the async-recompute background worker connects to. Only used when `async_recompute` is `on`. Restart required. |
| `pg_reactive.batch_invalidation` | `PGC_SUSET` | `on` | Defer recompute to transaction pre-commit, batching multiple DML statements into a single recompute per query. Runtime-settable (superuser). |
| `pg_reactive.notify_channel` | `PGC_SUSET` | `pgr` | The `LISTEN`/`NOTIFY` channel carrying all delta, overflow, and invalidation payloads. Runtime-settable (superuser). |

The `PGC_*` context is PostgreSQL's term for *when* a setting can change:
`PGC_POSTMASTER` means "only at server start", `PGC_SUSET` means "a
superuser can change it at runtime (and per-session)".

## Restart-only parameters (`PGC_POSTMASTER`)

`max_subscriptions`, `async_recompute`, and `database` are read once when
the postmaster starts. Changing them requires a full PostgreSQL restart —
a reload (`SELECT pg_reload_conf();`) is not enough, and `SET` in a
session is rejected.

### `pg_reactive.max_subscriptions`

This sizes the shared-memory hash that maps query IDs to their table
dependencies. It is allocated up front at startup, so it cannot grow on
the fly. Raise it before you expect to exceed ~1024 concurrent live
queries; the LRU evictor reclaims the oldest subscriptions once the table
is full, so an undersized value degrades silently rather than erroring.

```ini
# postgresql.conf
shared_preload_libraries = 'pg_reactive'
pg_reactive.max_subscriptions = 4096
```

### `pg_reactive.async_recompute` and `pg_reactive.database`

By default recompute runs inline inside the AFTER-STATEMENT trigger that
fired it. Turning `async_recompute` on registers a background worker that
performs recompute off the writer's critical path; `database` tells that
worker which database to attach to (it can only serve one). Leave
`async_recompute` `off` for most workloads — inline recompute is simpler
and fine until write volume makes the trigger latency unacceptable.

```ini
# postgresql.conf
shared_preload_libraries = 'pg_reactive'
pg_reactive.async_recompute = on
pg_reactive.database = appdb
```

### Setting them in Docker

In a container the cleanest way to pass `PGC_POSTMASTER` GUCs is the
`postgres -c` command line in `docker-compose.yml`, which the postmaster
reads at startup:

```yaml
services:
  db:
    image: pg_reactive
    command: >
      postgres
      -c shared_preload_libraries=pg_reactive
      -c pg_reactive.max_subscriptions=4096
      -c pg_reactive.async_recompute=on
      -c pg_reactive.database=appdb
```

### The tmpfs / `ALTER SYSTEM` caveat

`ALTER SYSTEM SET pg_reactive.max_subscriptions = 4096;` writes to
`postgresql.auto.conf` inside the data directory. In the development
setup the data directory lives on **tmpfs** (ephemeral RAM), so anything
written by `ALTER SYSTEM` is wiped on the next container restart and your
change silently reverts to the default. For `PGC_POSTMASTER` GUCs in a
tmpfs deployment, always use the `-c` flags on the `command:` line (or a
baked-in `postgresql.conf`) — those survive the restart; `ALTER SYSTEM`
does not.

## Runtime parameters (`PGC_SUSET`)

`batch_invalidation` and `notify_channel` are `PGC_SUSET`: a superuser can
change them at runtime, either globally or for a single session, with no
restart.

```sql
-- Per session
SET pg_reactive.batch_invalidation = off;

-- Persisted across restarts (writes postgresql.auto.conf; see tmpfs caveat above)
ALTER SYSTEM SET pg_reactive.batch_invalidation = off;
SELECT pg_reload_conf();
```

### `pg_reactive.batch_invalidation`

On (the default), multiple DML statements in one transaction collapse into
a single recompute per affected query, fired at pre-commit. Turning it off
makes every statement recompute immediately, which produces more
intermediate deltas but can lower per-statement latency for trickle
writes. It is `PGC_SUSET` rather than `PGC_USERSET` deliberately: toggling
it mid-transaction can drop a notification (the trigger marks a query dirty
on the batch path, then pre-commit sees batching off), so only superusers
may change it.

### `pg_reactive.notify_channel` — proxy caveat

This is the single channel name on which the extension emits **all**
deltas, overflows, and invalidations. The default is `pgr`.

> **The bundled Go proxy hardcodes `LISTEN pgr`.** If you change
> `notify_channel` to anything other than `pgr`, the proxy stops receiving
> notifications and the WebSocket path goes silent — even though the
> extension is working correctly. Only the default `pgr` works
> end-to-end through the proxy.

Change `notify_channel` only if you are consuming the channel yourself
(e.g. a custom `LISTEN` client or a separate `NOTIFY` listener) rather than
through the proxy described in [Proxy](./proxy.md). If you are using the
proxy, leave it at `pgr`.

```sql
-- Only safe when you are NOT using the bundled proxy
SET pg_reactive.notify_channel = 'my_app_channel';
```

## Verifying current values

Like any GUC, these are readable with `SHOW` or `current_setting()`:

```sql
SHOW pg_reactive.max_subscriptions;
SELECT current_setting('pg_reactive.notify_channel');

-- All five at once
SELECT name, setting, context, unit
FROM pg_settings
WHERE name LIKE 'pg_reactive.%'
ORDER BY name;
```

The `context` column in `pg_settings` will read `postmaster` for the three
restart-only GUCs and `superuser` for the two runtime-settable ones.

## Not GUCs: proxy environment variables

The proxy is configured separately, through environment variables
(`JWT_SECRET`, listen address, connection limits, and so on), **not**
through these GUCs. Those are documented on the platform side under
[Environment Variables](/deploy/env-vars). The five parameters on this
page configure the PostgreSQL extension itself; the proxy's env vars
configure the WebSocket gateway in front of it.

## See also

- [Install](./install.md) — getting `shared_preload_libraries` set.
- [Architecture](./architecture.md) — what recompute and batching actually do.
- [Wire Format](./wire-format.md) — the overflow threshold and channel payloads `notify_channel` carries.
- [Proxy](./proxy.md) — why the proxy pins `LISTEN pgr`.
