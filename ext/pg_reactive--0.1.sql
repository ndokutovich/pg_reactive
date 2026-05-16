-- pg_reactive extension install script v0.1
\echo Use "CREATE EXTENSION pg_reactive" to load this extension. \quit

CREATE SCHEMA IF NOT EXISTS pgr;

-- Subscribe to a live query
-- mode: 'delta' (default) = full EXCEPT diff with snapshots
--       'notify' = lightweight invalidation signal only
CREATE FUNCTION pgr.subscribe(
    query_id text,
    query text,
    mode text DEFAULT 'delta'
) RETURNS jsonb
AS 'MODULE_PATHNAME', 'pgr_subscribe'
LANGUAGE C;

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
    OUT invalidation_count bigint,
    OUT mode text
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_get_subscriptions'
LANGUAGE C STRICT;

CREATE VIEW pgr.subscriptions AS
    SELECT * FROM pgr.get_subscriptions();

-- Trigger function for DML interception on tracked tables.
-- SECURITY DEFINER so recompute/snapshot SPI calls run as the extension owner
-- regardless of which role is performing the DML on tracked tables.
CREATE FUNCTION pgr.trigger_func()
RETURNS trigger
AS 'MODULE_PATHNAME', 'pgr_trigger_func'
LANGUAGE C
SECURITY DEFINER
SET search_path = pgr, pg_catalog, public;

-- Extension stats
CREATE FUNCTION pgr.stats(
    OUT metric text,
    OUT value text
) RETURNS SETOF record
AS 'MODULE_PATHNAME', 'pgr_stats'
LANGUAGE C STRICT;

-- Allow all roles to see the pgr schema (needed for RLS policy expressions
-- and for trigger_func SPI calls which run SECURITY DEFINER).
GRANT USAGE ON SCHEMA pgr TO PUBLIC;

-- Restrict every pgr.* SQL function to the database owner by default.
-- Grant to specific roles as needed (e.g., the proxy connection role).
-- stats() and get_subscriptions() leak query_id/query_text and aggregate
-- counters that can be probed for tenant fingerprinting; lock them down
-- by default and let operators GRANT to authenticated/service_role on
-- purpose if that's what they want.
REVOKE EXECUTE ON FUNCTION pgr.subscribe(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.unsubscribe(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.get_subscriptions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.stats() FROM PUBLIC;
REVOKE SELECT ON pgr.subscriptions FROM PUBLIC;

-- Function documentation
COMMENT ON FUNCTION pgr.subscribe(text, text, text) IS
    'Register a live query. Mode: delta (default) = full diff with snapshots, notify = lightweight invalidation. '
    'Returns {"status":"subscribed","tables":N,"mode":"...","query_id":"..."}.';

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
