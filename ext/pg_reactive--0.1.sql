-- pg_reactive extension install script v0.1
\echo Use "CREATE EXTENSION pg_reactive" to load this extension. \quit

CREATE SCHEMA IF NOT EXISTS pgr;

-- Subscribe to a live query
CREATE FUNCTION pgr.subscribe(
    query_id text,
    query text
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'pgr_subscribe'
LANGUAGE C STRICT;

-- Unsubscribe from a live query
CREATE FUNCTION pgr.unsubscribe(
    query_id text
) RETURNS boolean
AS 'MODULE_PATHNAME', 'pgr_unsubscribe'
LANGUAGE C STRICT;

-- List all active subscriptions
CREATE FUNCTION pgr.get_subscriptions(
    OUT query_id text,
    OUT query_text text,
    OUT num_tables integer,
    OUT subscribed_at timestamptz,
    OUT invalidation_count bigint
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_get_subscriptions'
LANGUAGE C STRICT;

CREATE VIEW pgr.subscriptions AS
    SELECT * FROM pgr.get_subscriptions();

-- Trigger function for DML interception on tracked tables
CREATE FUNCTION pgr.trigger_func()
RETURNS trigger
AS 'MODULE_PATHNAME', 'pgr_trigger_func'
LANGUAGE C;

-- Extension stats
CREATE FUNCTION pgr.stats(
    OUT metric text,
    OUT value text
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_stats'
LANGUAGE C STRICT;

-- Function documentation
COMMENT ON FUNCTION pgr.subscribe(text, text) IS
    'Register a live query. Returns {"status":"subscribed","tables":N,"query_id":"..."}. '
    'Installs DML triggers on dependency tables and creates a snapshot for delta computation.';

COMMENT ON FUNCTION pgr.unsubscribe(text) IS
    'Remove a live query subscription. Drops snapshot table and per-query triggers. '
    'Returns true if the subscription existed.';

COMMENT ON FUNCTION pgr.get_subscriptions() IS
    'List all active subscriptions with query_id, query_text, table count, timestamps, and invalidation stats.';

COMMENT ON VIEW pgr.subscriptions IS
    'Convenience view over pgr.get_subscriptions().';

COMMENT ON FUNCTION pgr.trigger_func() IS
    'Internal trigger function installed on tracked tables. '
    'Fires AFTER INSERT/UPDATE/DELETE to recompute and NOTIFY deltas.';

COMMENT ON FUNCTION pgr.stats() IS
    'Extension-wide statistics: subscribe/unsubscribe/invalidation/eviction counts and active subscription count.';
