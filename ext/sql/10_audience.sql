-- Test: audience-bound subscriptions (finding F1, 0.1.2)
CREATE EXTENSION pg_reactive;

CREATE TABLE inv (id serial PRIMARY KEY, player_id text, val int);
INSERT INTO inv (player_id, val) VALUES ('42', 100), ('99', 200);

-- 1. Subscribe without audience (legacy public). audience is NULL.
SELECT pgr.subscribe('aud_pub', 'SELECT id, val FROM inv');
SELECT query_id, audience FROM pgr.get_subscriptions() WHERE query_id = 'aud_pub';

-- 2. Subscribe with single-key audience {"sub":"42"}.
SELECT pgr.subscribe(
  'aud_42',
  'SELECT id, val FROM inv WHERE player_id = ''42''',
  'delta',
  '{"sub":"42"}'::jsonb);
SELECT query_id, audience FROM pgr.get_subscriptions() WHERE query_id = 'aud_42';

-- 3. Subscribe with multi-key audience.
SELECT pgr.subscribe(
  'aud_multi',
  'SELECT id, val FROM inv',
  'delta',
  '{"sub":"42","org":"acme"}'::jsonb);
SELECT query_id, audience FROM pgr.get_subscriptions() WHERE query_id = 'aud_multi';

-- 4. Notify-mode with audience also works.
SELECT pgr.subscribe(
  'aud_notify',
  'SELECT id FROM inv',
  'notify',
  '{"role":"admin"}'::jsonb);
SELECT query_id, mode, audience FROM pgr.get_subscriptions() WHERE query_id = 'aud_notify';

-- 5. Re-subscribe with different audience updates in place (entry reuse).
SELECT pgr.subscribe(
  'aud_42',
  'SELECT id, val FROM inv WHERE player_id = ''42''',
  'delta',
  '{"sub":"99"}'::jsonb);
SELECT query_id, audience FROM pgr.get_subscriptions() WHERE query_id = 'aud_42';

-- 6. Audience too long is rejected (>512 bytes).
SELECT pgr.subscribe(
  'aud_huge',
  'SELECT id FROM inv',
  'delta',
  ('{"k":"' || repeat('x', 600) || '"}')::jsonb);

-- 7. List all subscriptions sorted.
SELECT query_id, mode, audience FROM pgr.get_subscriptions() ORDER BY query_id;

-- 8. Unsubscribe each.
SELECT pgr.unsubscribe('aud_pub');
SELECT pgr.unsubscribe('aud_42');
SELECT pgr.unsubscribe('aud_multi');
SELECT pgr.unsubscribe('aud_notify');

-- Cleanup.
DROP TABLE inv;
DROP EXTENSION pg_reactive;
