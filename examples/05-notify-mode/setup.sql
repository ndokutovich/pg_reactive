-- Example 05 — Notify Mode (lightweight invalidation)
--
-- `mode = 'notify'` is for "I just need to know SOMETHING changed, then
-- I'll fetch the latest myself". The DB doesn't compute or store a
-- snapshot, doesn't run EXCEPT, doesn't ship deltas. Just a tiny
-- invalidation signal on `NOTIFY pgr`.
--
-- When to choose notify over delta:
--   * High-frequency writes where computing deltas is too expensive.
--   * Data the client already has via REST poll / cache; just needs a
--     wake-up to refresh.
--   * Tabular data where the client renders whatever pg_reactive sends
--     directly is overkill (e.g. a sensor feed that's been throttled).
--
-- The proxy still gates auth and audience the same way — notify-mode
-- doesn't bypass authz, it just changes the wire shape.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS sensor_readings (
  id          serial PRIMARY KEY,
  sensor_id   text NOT NULL,
  temperature numeric(5,2) NOT NULL,
  humidity    numeric(5,2) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON sensor_readings TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE sensor_readings_id_seq TO anon, authenticated;

TRUNCATE sensor_readings RESTART IDENTITY CASCADE;
INSERT INTO sensor_readings (sensor_id, temperature, humidity) VALUES
  ('A', 22.5, 45.0), ('A', 23.1, 44.2),
  ('B', 19.8, 62.3), ('B', 20.1, 61.8),
  ('C', 25.7, 38.5);

-- notify: client receives an "invalidated" signal — no row data.
SELECT pgr.subscribe(
  'sensor_notify',
  'SELECT * FROM sensor_readings ORDER BY recorded_at DESC',
  'notify');

-- delta: same query, but client receives row-level inserted/deleted.
SELECT pgr.subscribe(
  'sensor_delta',
  'SELECT * FROM sensor_readings ORDER BY recorded_at DESC LIMIT 20',
  'delta');
