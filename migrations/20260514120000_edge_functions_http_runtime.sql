-- Migration: edge_functions_http_runtime
-- Created at: 2026-05-14T12:00:00.000Z
--
-- Adds the `http` edge-function runtime: a per-function `upstream_url` column
-- plus the constraints that enforce it. Fresh installs get this from
-- docker/init.sql; this file is the upgrade path for an existing persistent
-- database (init.sql's CREATE TABLE IF NOT EXISTS is a no-op once the table
-- exists). Apply with `pgstack migration run`.

-- migrate:up
ALTER TABLE pgstack.edge_functions
    ADD COLUMN IF NOT EXISTS upstream_url TEXT;

-- The original `runtime` CHECK is an inline, auto-named constraint; its name
-- can differ between installs. Drop whichever CHECK constraint references the
-- `runtime` column, then add the 5-value one under a known name.
DO $$
DECLARE c text;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'pgstack.edge_functions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%runtime%'
    LOOP
        EXECUTE format('ALTER TABLE pgstack.edge_functions DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

ALTER TABLE pgstack.edge_functions
    ADD CONSTRAINT edge_functions_runtime_check
    CHECK (runtime IN ('embedded', 'plv8', 'plpython3u', 'deno', 'http'));

ALTER TABLE pgstack.edge_functions
    DROP CONSTRAINT IF EXISTS edge_functions_http_needs_upstream;
ALTER TABLE pgstack.edge_functions
    ADD CONSTRAINT edge_functions_http_needs_upstream
    CHECK (runtime <> 'http' OR upstream_url IS NOT NULL) NOT VALID;
ALTER TABLE pgstack.edge_functions
    VALIDATE CONSTRAINT edge_functions_http_needs_upstream;

ALTER TABLE pgstack.edge_functions
    DROP CONSTRAINT IF EXISTS edge_functions_upstream_url_scheme;
ALTER TABLE pgstack.edge_functions
    ADD CONSTRAINT edge_functions_upstream_url_scheme
    CHECK (upstream_url IS NULL OR upstream_url ~ '^https?://') NOT VALID;
ALTER TABLE pgstack.edge_functions
    VALIDATE CONSTRAINT edge_functions_upstream_url_scheme;

-- migrate:down
-- Note: rolling back fails if any runtime='http' rows still exist (the
-- 4-value CHECK would reject them) — delete those functions first. The
-- upstream_url column is intentionally NOT dropped, so a re-up keeps data.
ALTER TABLE pgstack.edge_functions
    DROP CONSTRAINT IF EXISTS edge_functions_upstream_url_scheme;
ALTER TABLE pgstack.edge_functions
    DROP CONSTRAINT IF EXISTS edge_functions_http_needs_upstream;

DO $$
DECLARE c text;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'pgstack.edge_functions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%runtime%'
    LOOP
        EXECUTE format('ALTER TABLE pgstack.edge_functions DROP CONSTRAINT %I', c);
    END LOOP;
END $$;

ALTER TABLE pgstack.edge_functions
    ADD CONSTRAINT edge_functions_runtime_check
    CHECK (runtime IN ('embedded', 'plv8', 'plpython3u', 'deno'));
