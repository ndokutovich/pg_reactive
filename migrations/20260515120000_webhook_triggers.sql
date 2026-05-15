-- Migration: webhook_triggers
-- Created at: 2026-05-15T12:00:00.000Z
--
-- Adds the trigger-based webhook delivery mechanism. Webhooks previously tried
-- to derive events from the 'pgr' live-query delta stream, which carries no
-- table name and only fires when a live query is subscribed — so they never
-- delivered. This adds a dedicated AFTER ROW trigger that emits table-aware
-- events on the 'pgstack_webhooks' NOTIFY channel.
--
-- Fresh installs get this from docker/init.sql; this file is the upgrade path
-- for an existing persistent database. Apply with `pgstack migration run`.

-- migrate:up
CREATE OR REPLACE FUNCTION pgstack.webhook_notify() RETURNS trigger AS $$
DECLARE
  payload text;
BEGIN
  payload := json_build_object(
    'table',      TG_TABLE_NAME,
    'event',      TG_OP,
    'record',     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_to_json(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE row_to_json(OLD) END
  )::text;
  IF octet_length(payload) <= 7900 THEN
    PERFORM pg_notify('pgstack_webhooks', payload);
  ELSE
    PERFORM pg_notify('pgstack_webhooks', json_build_object(
      'table', TG_TABLE_NAME, 'event', TG_OP, 'oversized', true
    )::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pgstack.enable_webhook_trigger(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS pgstack_webhook_trg ON %s', tbl);
  EXECUTE format(
    'CREATE TRIGGER pgstack_webhook_trg AFTER INSERT OR UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION pgstack.webhook_notify()', tbl);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pgstack.disable_webhook_trigger(tbl regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS pgstack_webhook_trg ON %s', tbl);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION pgstack.enable_webhook_trigger(regclass)  TO service_role;
GRANT EXECUTE ON FUNCTION pgstack.disable_webhook_trigger(regclass) TO service_role;

-- Re-arm triggers for any tables that already have an active webhook, so an
-- upgrade does not silently leave existing webhooks dead until they are
-- recreated.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name FROM pgstack.webhooks
    WHERE active = true AND table_name <> '*'
  LOOP
    BEGIN
      PERFORM pgstack.enable_webhook_trigger(t::regclass);
    EXCEPTION WHEN undefined_table THEN
      RAISE WARNING 'webhook table % no longer exists — skipping trigger install', t;
    END;
  END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name FROM pgstack.webhooks
    WHERE table_name <> '*'
  LOOP
    BEGIN
      PERFORM pgstack.disable_webhook_trigger(t::regclass);
    EXCEPTION WHEN undefined_table THEN
      NULL;
    END;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS pgstack.enable_webhook_trigger(regclass);
DROP FUNCTION IF EXISTS pgstack.disable_webhook_trigger(regclass);
DROP FUNCTION IF EXISTS pgstack.webhook_notify();
