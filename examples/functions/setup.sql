-- Register the reference polyglot edge function (runtime="http").
--
-- The `setup` service in examples/docker-compose.yml runs every
-- /examples/*/setup.sql — this file sits at exactly that glob depth, so the
-- function is registered automatically when the examples stack comes up.
--
-- verify_jwt=false keeps the demo callable with just the anon key; flip it to
-- true for functions that must require a real JWT.

INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, upstream_url, status)
VALUES ('hello-go', 'http', false, 'http://hello-go:9100', 'active')
ON CONFLICT (name) DO UPDATE
SET runtime      = EXCLUDED.runtime,
    verify_jwt   = EXCLUDED.verify_jwt,
    upstream_url = EXCLUDED.upstream_url,
    status       = 'active',
    updated_at   = now();
