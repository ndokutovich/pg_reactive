-- Test: extension loads and is registered.
--
-- A single DO block asserts the post-conditions (extension registered,
-- extversion matches the control file's default_version, pgr schema
-- created). On success it emits the bare "DO" tag — no psql column
-- output to keep in whitespace-sync each time default_version bumps in
-- pg_reactive.control. On any assertion failure pg_regress sees the
-- ERROR line and flags the test as failed.
CREATE EXTENSION pg_reactive;

DO $$ BEGIN
    ASSERT (SELECT count(*) FROM pg_extension WHERE extname = 'pg_reactive') = 1,
        'pg_reactive extension is not registered';
    ASSERT (SELECT extversion FROM pg_extension WHERE extname = 'pg_reactive') =
           (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_reactive'),
        'pg_reactive extversion does not match control default_version';
    ASSERT (SELECT count(*) FROM pg_namespace WHERE nspname = 'pgr') = 1,
        'pgr schema was not created by the extension';
END $$;

DROP EXTENSION pg_reactive;
