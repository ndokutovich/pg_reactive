-- Example 11: Notify Mode (Lightweight Invalidation)
-- Demonstrates: notify mode vs delta mode side-by-side
-- Notify mode sends {"type":"invalidated"} instead of full row diffs.
-- Use when you don't need row-level deltas — just "something changed".

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS sensor_readings (
  id SERIAL PRIMARY KEY,
  sensor_id TEXT NOT NULL,
  temperature NUMERIC(5,2) NOT NULL,
  humidity NUMERIC(5,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sensor_readings TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE sensor_readings_id_seq TO anon, authenticated;

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
