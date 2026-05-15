-- Migration: pg_reactive 0.1.1 -> 0.1.2 (audience-bound subscriptions)
-- Created at: 2026-05-16T12:00:00.000Z
--
-- Closes audit finding F1 (deep fix). Adds the `audience` parameter to
-- pgr.subscribe and the matching output column to pgr.get_subscriptions.
-- Subscriptions registered with a non-NULL audience are deliverable only to
-- JWTs whose claims satisfy that predicate; the proxy enforces this at
-- WS-connect time. NULL audience preserves the legacy public behaviour.
--
-- Operational notes:
--   * The shared-memory entry layout grew by PGR_AUDIENCE_LEN (512 bytes)
--     per slot. The new pg_reactive.so cannot be hot-swapped while the
--     server is running — restart PostgreSQL after this migration.
--   * Existing subscriptions are preserved across the restart cycle EXCEPT
--     that shmem is wiped on restart anyway in the dev compose setup
--     (tmpfs); production deployments using persistent shmem keep entries
--     in old layout until the next subscribe() rewrites them.
--   * No data migration is needed — audience defaults to NULL for any
--     existing subscription.

-- migrate:up

ALTER EXTENSION pg_reactive UPDATE TO '0.1.2';

-- migrate:down

-- pg_reactive has no native downgrade path (extension scripts run forward
-- only). To revert, install the 0.1.1 .so binary and re-create the schema.
SELECT 1;
