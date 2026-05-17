-- Audit F3 round 21: pgstack.storage_buckets.id is also the on-disk
-- subdirectory under STORAGE_DIR. Reject any id that collides with the
-- reserved ".pgstack-staging" sweep root or that contains characters
-- outside the on-disk-safe alphabet (lowercase alnum, underscore, hyphen).
-- Without this constraint, a service_role caller could create a bucket
-- named ".pgstack-staging" and have real objects deleted by the next
-- SweepDiskOrphans run.
--
-- The proxy already enforces the same regex at CreateBucket time; this
-- migration adds the CHECK at the DB layer as defence-in-depth for raw
-- SQL inserts (psql, ad-hoc admin scripts, ETL).
--
-- Existing rows that violate the constraint are NOT silently dropped —
-- the ALTER TABLE will fail loudly and the operator must rename or
-- delete the offending bucket first. That's intentional: silently
-- removing storage_buckets rows would orphan their storage_objects.

ALTER TABLE pgstack.storage_buckets
    ADD CONSTRAINT bucket_id_on_disk_safe
    CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
