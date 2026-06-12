-- 14_generation (round 39 batch-2 F1/F2/F3): every subscribe/unsubscribe draws a
-- fresh monotonic generation from pgr.subscription_generation_seq, records it in
-- the catalog, and surfaces it through pgr.subscription_meta. The Go proxy binds
-- each WebSocket to the generation it authorized against and revokes any older
-- one, so a metadata change disconnects stale connections immediately. This test
-- proves the catalog/generation half; the NOTIFY-wire half (the 'resubscribed'
-- announcement that drives RevokeStale) is covered by the e2e suite.
--
-- Generations come from a sequence whose absolute value accumulates across the
-- pg_regress session, so every assertion below is RELATIVE (\gset + comparison)
-- and stays deterministic regardless of prior tests.
DROP EXTENSION IF EXISTS pg_reactive CASCADE;
CREATE EXTENSION pg_reactive;

CREATE TABLE g (id serial PRIMARY KEY, v int);

-- subscribe assigns a generation; capture it.
SELECT pgr.subscribe('gen_a', 'SELECT id, v FROM g');
SELECT generation AS gen_a1 FROM pgr.subscription_meta('gen_a') \gset

-- re-subscribing the SAME query_id (here, adding an audience) bumps the
-- generation strictly upward — this is the metadata change that must revoke
-- every connection authorized against the previous generation.
SELECT pgr.subscribe('gen_a', 'SELECT id, v FROM g', 'delta', '{"sub":"42"}'::jsonb);
SELECT generation AS gen_a2 FROM pgr.subscription_meta('gen_a') \gset
SELECT :gen_a2 > :gen_a1 AS resubscribe_bumped_generation;

-- subscription_meta surfaces the updated audience alongside the new generation.
SELECT mode, audience, (generation = :gen_a2) AS generation_matches
FROM pgr.subscription_meta('gen_a');

-- a different subscription draws a later generation from the shared sequence.
SELECT pgr.subscribe('gen_b', 'SELECT id FROM g');
SELECT generation AS gen_b1 FROM pgr.subscription_meta('gen_b') \gset
SELECT :gen_b1 > :gen_a2 AS second_subscription_is_monotonic;

-- unsubscribe advances the generation AND removes the catalog row, so
-- subscription_meta returns nothing — every later connect now fails closed.
SELECT pgr.unsubscribe('gen_b');
SELECT count(*)::int AS meta_rows_after_unsubscribe FROM pgr.subscription_meta('gen_b');

-- the generation source is default-denied to PUBLIC: no app role can forge a
-- generation to dodge revocation.
SELECT has_sequence_privilege('public', 'pgr.subscription_generation_seq', 'USAGE') AS public_can_use_seq;

-- Cleanup.
SELECT pgr.unsubscribe('gen_a');
DROP TABLE g;
DROP EXTENSION pg_reactive;
