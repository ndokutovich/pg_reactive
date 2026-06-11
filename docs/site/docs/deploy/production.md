---
title: Production Checklist
sidebar_position: 3
description: Security and reliability checklist for deploying pgStack to production.
---

# Production Checklist

Before launching pgStack in production, review the following checklist.

## Security

### Secrets

- [ ] `POSTGRES_PASSWORD` is a strong random value generated with `openssl rand -base64 32`
- [ ] `JWT_SECRET` is 32+ characters, generated randomly
- [ ] `JWT_SECRET` does not contain `dev-only` — with `PGSTACK_ENV=production` (set by `docker-compose.prod.yml`) the proxy refuses to start if it does; outside production it only warns
- [ ] `ANON_KEY` is a strong random value
- [ ] `SERVICE_ROLE_KEY` is a strong random value — treat it like a database root password
- [ ] `.env` file is in `.gitignore` and never committed to version control
- [ ] `SITE_URL` is set to your production URL (required for OAuth redirects and email links)
- [ ] No development defaults (`dev-only-*`) remain in your production environment

### Network

- [ ] PostgreSQL port `5432` is NOT exposed to the internet (only accessible within Docker network)
- [ ] pgStack proxy port `8080` is behind a reverse proxy (Caddy, nginx, Traefik)
- [ ] HTTPS is enforced — HTTP redirects to HTTPS
- [ ] `ALLOWED_ORIGINS` is set to your specific domain(s), not empty
- [ ] `ALLOW_PERMISSIVE_CORS` is `false` or unset (strict CORS by default since 2026-05)
- [ ] Studio (`/studio/`) is restricted to trusted IPs or protected with additional auth
- [ ] Configure `TLS_MODE=auto` for automatic HTTPS, or use a reverse proxy with `TLS_MODE=off` (default)
- [ ] `TRUSTED_PROXIES` is set to the IP(s) of your reverse proxy — prevents rate limit bypass via `X-Forwarded-For` spoofing
- [ ] HSTS is automatically added when TLS is active (via `TLS_MODE=auto` or `TLS_MODE=manual`)
- [ ] WebSocket connections validate Origin header against `ALLOWED_ORIGINS`
- [ ] `REQUIRE_AUTHENTICATED_WS=true` — required in production: the `PGSTACK_ENV=production` validator refuses to start with `false`, and `docker-compose.prod.yml` sets it to `true` (rejects anon-key WS subscriptions; requires JWT)

### Database

- [ ] `POSTGRES_HOST_AUTH_METHOD` is `scram-sha-256` (not `trust`)
- [ ] `ENABLE_SQL_ENDPOINT` is `false`
- [ ] `ENABLE_DEMO_ENDPOINT` is `false` or unset
- [ ] `SECRETS_ENCRYPTION_KEY` is set to a strong random 32-byte value if any of these are in use: edge function env vars, webhook signing secrets. Without it, `CreateWebhook` refuses non-empty secrets and existing encrypted rows are dropped from the delivery cache (fail-closed).
- [ ] Existing deployments have run `migrations/20260515210000_hash_tokens_encrypt_envvars.sql` (refresh + email tokens are stored as SHA-256 hashes; env vars are AES-256-GCM encrypted) and `migrations/20260516120000_encrypt_webhook_secrets.sql` (webhook signing secrets moved from plaintext to `secret_encrypted` — webhooks must be re-created with new secrets after the migration)
- [ ] RLS is enabled on all user-facing tables
- [ ] `anon` and `authenticated` roles have only the minimum necessary permissions
- [ ] Internal auth tables (`pgstack.refresh_tokens`, `pgstack.oauth_sessions`, `pgstack.email_tokens`) have RLS enabled

## Reliability

### Backups

- [ ] Automated daily backups configured (pg_dump to S3, Backblaze B2, etc.)
- [ ] Backup restoration tested at least once
- [ ] Backup retention policy defined (e.g., keep 7 daily, 4 weekly)

### Health checks

The production compose file includes health checks. Verify they work:

```bash
docker compose -f docker-compose.prod.yml ps
# Both services should show "healthy"

# Proxy health endpoint
curl https://your-app.example.com/health
# {"status":"ok","pg_connected":true}
```

### Container restart policy

The production compose file sets `restart: unless-stopped`. Verify containers automatically restart after a reboot:

```bash
# Reboot test
sudo reboot
# After reboot:
docker compose -f docker-compose.prod.yml ps
```

### Subscription recovery after a PostgreSQL restart

Live-query state lives in shared memory and is wiped by every PostgreSQL restart (crash, `docker compose restart`, host reboot, image update). The extension keeps a durable catalog — `pgr.persisted_subscriptions`, a LOGGED table maintained automatically by `pgr.subscribe` / `pgr.unsubscribe` — but it is only replayed into shared memory on request:

```bash
docker compose -f docker-compose.prod.yml exec db \
  psql -U postgres -d app -c "SELECT pgr.restore_subscriptions();"
```

Run this once per database after every restart — until then, subscribed queries emit no deltas. The function returns the number of subscriptions restored and has `EXECUTE` revoked from `PUBLIC` (superuser or an explicitly granted role only). The all-in-one image runs it automatically at boot; the two-container production stack does not, so add it to your restart runbook.

### Resource limits

- [ ] Memory limits are appropriate for your workload (see `deploy.resources.limits`)
- [ ] `max_connections` in PostgreSQL matches your expected connection count
- [ ] `pg_reactive.max_subscriptions` is appropriate for your WebSocket client count

## Performance

### PostgreSQL configuration

For a server with 4 GB RAM:

```yaml
command: >
  postgres
    -c shared_preload_libraries=pg_reactive
    -c shared_buffers=1GB
    -c effective_cache_size=3GB
    -c work_mem=16MB
    -c maintenance_work_mem=256MB
    -c max_connections=200
    -c pg_reactive.max_subscriptions=2048
    -c log_min_messages=warning
    -c log_statement=none
    -c random_page_cost=1.1
    -c checkpoint_completion_target=0.9
    -c wal_buffers=64MB
```

### Indexes

Ensure all frequently queried columns are indexed, especially columns used in RLS policies and live query filters:

```sql
-- Index columns used in RLS policies
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_todos_user_id ON todos(user_id);

-- Index columns used in live query WHERE clauses
CREATE INDEX idx_orders_status ON orders(status) WHERE status != 'completed';
```

### Connection pooling

For high traffic, add PgBouncer in front of PostgreSQL:

```yaml
# Add to docker-compose.prod.yml
pgbouncer:
  image: bitnami/pgbouncer:latest
  environment:
    PGBOUNCER_DATABASE: app
    POSTGRESQL_HOST: db
    POSTGRESQL_USERNAME: postgres
    POSTGRESQL_PASSWORD: ${POSTGRES_PASSWORD}
    POSTGRESQL_DATABASE: app
    PGBOUNCER_POOL_MODE: transaction
    PGBOUNCER_MAX_CLIENT_CONN: 1000
    PGBOUNCER_DEFAULT_POOL_SIZE: 20
  ports:
    - "127.0.0.1:6432:6432"
```

Then point `DATABASE_URL` at PgBouncer instead of PostgreSQL directly.

Tune the proxy's built-in connection pool before reaching for PgBouncer:

- [ ] `PG_POOL_MAX_CONNS` (default 50) — raise for high-concurrency workloads
- [ ] `PG_POOL_MIN_CONNS` (default 5) — keeps connections warm to avoid cold-start latency

For advanced pooling (transaction mode), add PgBouncer between the proxy and PostgreSQL as shown above.

### Proxy configuration

- [ ] **Compression** — Gzip compression is enabled by default (`GZIP_LEVEL=5`). Set to `0` to disable if your reverse proxy handles compression.
- [ ] **Timeouts** — Adjust `READ_TIMEOUT` (default 30s) and `WRITE_TIMEOUT` (default 60s) based on expected query complexity. Long-running queries may need higher write timeouts.

## Monitoring

### Log aggregation

Forward Docker logs to a log aggregation service:

```yaml
# In docker-compose.prod.yml, add to each service:
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

Or use the `fluentd` or `loki` Docker log drivers to ship logs to your logging stack.

### Metrics

pgStack has no built-in `/metrics` endpoint. `/health` (status + `pg_connected`) is the only built-in observability endpoint; scrape it or use Docker/PostgreSQL exporters for metrics.

### Alerting

Set up alerts for:
- Container health check failures
- PostgreSQL disk usage > 80%
- Slow queries (> 1 second average)
- Error rate spikes in proxy logs

## Maintenance

### PostgreSQL VACUUM

PostgreSQL autovacuum handles routine maintenance automatically. For tables with high churn (frequent inserts/updates/deletes), monitor bloat:

```sql
SELECT
  relname AS table,
  n_dead_tup AS dead_rows,
  n_live_tup AS live_rows,
  round(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY dead_pct DESC;
```

If bloat is significant, run VACUUM manually during low-traffic periods:

```sql
VACUUM ANALYZE orders;
```

### pg_reactive snapshot tables

Live query snapshot tables (`pgr._snap_*`) are UNLOGGED — ordinary on-disk tables that skip WAL. They are created on subscribe and dropped on unsubscribe (or LRU eviction / DDL auto-unsubscribe) and require no maintenance.

## Upgrade procedure

1. Review the changelog for breaking changes
2. Test the upgrade in a staging environment
3. Take a database backup
4. Pull new images: `docker compose -f docker-compose.prod.yml pull`
5. Apply the update: `docker compose -f docker-compose.prod.yml up -d`
6. Run any new migrations: `pgstack migration run`
7. Verify the health endpoint and spot-check API responses
