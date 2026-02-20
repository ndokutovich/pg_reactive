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
