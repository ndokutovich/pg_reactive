-- Migration: encrypt_webhook_secrets
-- Created at: 2026-05-16T12:00:00.000Z
--
-- Closes audit finding F1 (round 7).
--
-- Before this migration pgstack.webhooks.secret was stored as plaintext.
-- Anyone with read access to the database (a DB dump, a backup, a
-- compromised replica) could forge X-Webhook-Signature on the
-- corresponding deliveries.
--
-- New shape: pgstack.webhooks.secret_encrypted BYTEA, populated by the
-- proxy via secrets.Box.Encrypt (AES-256-GCM under
-- SECRETS_ENCRYPTION_KEY). The plaintext is held only in proxy memory
-- after Refresh() decrypts.
--
-- The migration cannot re-encrypt existing secrets because the SQL
-- session doesn't have the encryption key. Two options:
--   * If your deployment was using webhook secrets — the secret column
--     is DROPPED here; you must re-create each webhook via
--     POST /rest/v1/webhooks so the new value lands in
--     secret_encrypted.
--   * If your deployment had empty webhook secrets — no data loss.

-- migrate:up

ALTER TABLE pgstack.webhooks ADD COLUMN IF NOT EXISTS secret_encrypted bytea;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'pgstack'
      AND table_name   = 'webhooks'
      AND column_name  = 'secret'
  ) THEN
    -- Loudly destroy plaintext secrets rather than silently leaving them.
    UPDATE pgstack.webhooks SET secret = '' WHERE secret <> '';
    ALTER TABLE pgstack.webhooks DROP COLUMN secret;
    RAISE NOTICE 'pgstack.webhooks.secret dropped (plaintext footgun). Re-create webhooks via POST /rest/v1/webhooks to land new signing secrets in secret_encrypted (encrypted under SECRETS_ENCRYPTION_KEY).';
  END IF;
END $$;

-- migrate:down

-- Restore plaintext column. Provided for emergency rollback only;
-- running this reintroduces F1.
ALTER TABLE pgstack.webhooks ADD COLUMN IF NOT EXISTS secret text NOT NULL DEFAULT '';
ALTER TABLE pgstack.webhooks DROP COLUMN IF EXISTS secret_encrypted;
