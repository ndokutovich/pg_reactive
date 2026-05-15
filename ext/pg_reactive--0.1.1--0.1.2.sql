-- pg_reactive 0.1.1 -> 0.1.2 upgrade
--
-- Adds the optional `audience` parameter to pgr.subscribe and the matching
-- output column to pgr.get_subscriptions. Bound subscriptions enforce
-- claim-matching at WS-connect time in the proxy. NULL audience preserves
-- the legacy public behaviour.
--
-- The shared-memory entry layout grew by PGR_AUDIENCE_LEN bytes, so the
-- new shared object cannot be hot-swapped while the server is running.
-- Restart PostgreSQL after `ALTER EXTENSION pg_reactive UPDATE`.
\echo Use "ALTER EXTENSION pg_reactive UPDATE" to apply this update. \quit

-- Drop the old subscribe and replace with the 4-arg variant.
DROP FUNCTION IF EXISTS pgr.subscribe(text, text, text);
CREATE FUNCTION pgr.subscribe(
    query_id text,
    query text,
    mode text DEFAULT 'delta',
    audience jsonb DEFAULT NULL
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'pgr_subscribe'
LANGUAGE C;

-- Drop and recreate get_subscriptions with the new audience column.
-- The view depends on it, so it has to be re-created as well.
DROP VIEW IF EXISTS pgr.subscriptions;
DROP FUNCTION IF EXISTS pgr.get_subscriptions();
CREATE FUNCTION pgr.get_subscriptions(
    OUT query_id text,
    OUT query_text text,
    OUT num_tables integer,
    OUT subscribed_at timestamptz,
    OUT invalidation_count bigint,
    OUT mode text,
    OUT audience jsonb
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_get_subscriptions'
LANGUAGE C STRICT;
CREATE VIEW pgr.subscriptions AS
    SELECT * FROM pgr.get_subscriptions();

REVOKE EXECUTE ON FUNCTION pgr.subscribe(text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.get_subscriptions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.stats()             FROM PUBLIC;

COMMENT ON FUNCTION pgr.subscribe(text, text, text, jsonb) IS
    'Register a live query. Mode: delta (default) = full diff with snapshots, notify = lightweight invalidation. '
    'audience: NULL = public, JSON object = proxy enforces every key matches the corresponding JWT claim at WS-connect. '
    'Returns {"status":"subscribed","tables":N,"mode":"...","query_id":"..."}.';

COMMENT ON FUNCTION pgr.get_subscriptions() IS
    'List all active subscriptions with query_id, query_text, table count, timestamps, invalidation stats, mode, and audience.';
