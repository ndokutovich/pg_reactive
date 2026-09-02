-- Example 11: Notify Mode (Lightweight Invalidation)
-- Demonstrates: notify mode vs delta mode side-by-side
-- Notify mode sends {"type":"invalidated"} instead of full row diffs.
-- Use when you don't need row-level deltas — just "something changed".

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Re-seed-safe: DROP first so a table left over from an OLDER demo schema is
-- replaced with the current one. `CREATE TABLE IF NOT EXISTS` silently keeps a
-- stale table when the schema EVOLVED, so a subscribe query could select a
-- column that no longer exists → "column ... does not exist" (SQLSTATE 42703).
-- Demo data is disposable and the setup service re-seeds on boot, so a
-- drop+recreate is the right idempotency. (Mirrors examples/apps/todo.)
DROP TABLE IF EXISTS public.sensor_readings CASCADE;
CREATE TABLE IF NOT EXISTS sensor_readings (
  id SERIAL PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  temperature NUMERIC(5,2) NOT NULL,
  humidity NUMERIC(5,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Production-ready: a public-READ sensor feed; new readings are pushed
-- server-side (psql / a device writer), writes locked to service_role.
ALTER TABLE sensor_readings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sensor_readings_public_read ON sensor_readings;
CREATE POLICY sensor_readings_public_read ON sensor_readings FOR SELECT TO anon, authenticated, anonymous USING (true);
GRANT SELECT ON sensor_readings TO anon, authenticated, anonymous;

-- Clean slate (idempotent re-runs in the umbrella every-boot scenario)
TRUNCATE sensor_readings RESTART IDENTITY CASCADE;

-- Seed some initial readings
INSERT INTO sensor_readings (sensor_id, temperature, humidity) VALUES
  ('sensor-A', 22.5, 45.0),
  ('sensor-A', 23.1, 44.2),
  ('sensor-B', 19.8, 62.3),
  ('sensor-B', 20.1, 61.8),
  ('sensor-C', 25.7, 38.5);

-- Notify mode: lightweight invalidation (no snapshot, no query re-execution)
-- Client receives {"type":"invalidated","query_id":"sensor_notify"}
SELECT pgr.unsubscribe('sensor_notify');
SELECT pgr.subscribe('sensor_notify',
  'SELECT * FROM sensor_readings ORDER BY recorded_at DESC',
  'notify');

-- Delta mode on same table for comparison
-- Client receives full {"inserted":[...],"deleted":[...]} diffs
SELECT pgr.unsubscribe('sensor_delta');
SELECT pgr.subscribe('sensor_delta',
  'SELECT * FROM sensor_readings ORDER BY recorded_at DESC',
  'delta');
