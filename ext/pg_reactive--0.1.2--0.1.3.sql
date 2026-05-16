-- pg_reactive 0.1.2 -> 0.1.3 upgrade
--
-- Security hardening only: revoke EXECUTE/SELECT on the introspection
-- helpers from PUBLIC so installations that started on 0.1 (before the
-- REVOKEs were added to the install script) get the same default-deny
-- posture as fresh 0.1.2+ installs. Closes audit finding L8.
--
-- pgr.subscribe and pgr.unsubscribe were already revoked on every
-- prior version, so no change is needed there.
\echo Use "ALTER EXTENSION pg_reactive UPDATE" to apply this update. \quit

REVOKE EXECUTE ON FUNCTION pgr.get_subscriptions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pgr.stats()             FROM PUBLIC;
REVOKE SELECT  ON pgr.subscriptions                FROM PUBLIC;
