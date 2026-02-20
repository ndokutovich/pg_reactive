-- Test: extension loads and is registered
CREATE EXTENSION pg_reactive;

SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_reactive';

-- Verify schema was created
SELECT nspname FROM pg_namespace WHERE nspname = 'pgr';

DROP EXTENSION pg_reactive;
