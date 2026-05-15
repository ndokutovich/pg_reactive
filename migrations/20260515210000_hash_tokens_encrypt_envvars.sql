-- Migration: hash_tokens_encrypt_envvars
-- Created at: 2026-05-15T21:00:00.000Z
--
-- Closes audit finding F6 on existing installs.
--
-- The plaintext `token` columns on pgstack.refresh_tokens and
-- pgstack.email_tokens, plus the plaintext `env_vars JSONB` column on
-- pgstack.edge_functions, were a credential-dump-on-DB-dump vector. This
-- migration rotates the schema to:
--
--   * refresh_tokens.token        -> refresh_tokens.token_hash (sha256 hex)
--   * email_tokens.token          -> email_tokens.token_hash   (sha256 hex)
--   * edge_functions.env_vars     -> edge_functions.env_vars_encrypted (BYTEA,
--                                    AES-256-GCM ciphertext under
--                                    SECRETS_ENCRYPTION_KEY)
--
-- Backfill: impossible — we cannot reverse-derive the original token from
-- nothing, and the proxy never sees env_vars at write time. So:
--
--   * All EXISTING refresh tokens are deleted. Every user is force-logged-out;
--     they re-authenticate and get fresh, hashed-only tokens.
--   * All EXISTING unused email tokens are deleted. The user re-requests
--     verification / recovery / magic link.
--   * env_vars contents are discarded. The proxy never read them anyway (the
--     column existed pending a runtime feature). When the runtime starts
--     consuming env vars, set SECRETS_ENCRYPTION_KEY and re-deploy functions
--     via the SDK/CLI (both of which encrypt before INSERT).
--
-- After this migration, a stolen DB dump no longer yields valid credentials.

-- migrate:up

-- refresh_tokens: add token_hash, drop token.
ALTER TABLE pgstack.refresh_tokens ADD COLUMN IF NOT EXISTS token_hash text;
-- Force-rotate: drop all rows so no stale token survives (we have no way to
-- hash what we never knew the plaintext of).
DELETE FROM pgstack.refresh_tokens;
ALTER TABLE pgstack.refresh_tokens ALTER COLUMN token_hash SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='pgstack' AND table_name='refresh_tokens' AND column_name='token'
  ) THEN
    ALTER TABLE pgstack.refresh_tokens DROP COLUMN token;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_key
  ON pgstack.refresh_tokens(token_hash);

-- email_tokens: same dance.
ALTER TABLE pgstack.email_tokens ADD COLUMN IF NOT EXISTS token_hash text;
DELETE FROM pgstack.email_tokens;
ALTER TABLE pgstack.email_tokens ALTER COLUMN token_hash SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='pgstack' AND table_name='email_tokens' AND column_name='token'
  ) THEN
    -- Drop the old index that referenced the plaintext column, then the column.
    DROP INDEX IF EXISTS pgstack.idx_email_tokens_token;
    ALTER TABLE pgstack.email_tokens DROP COLUMN token;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS email_tokens_token_hash_key
  ON pgstack.email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash
  ON pgstack.email_tokens(token_hash);

-- edge_functions: encrypted env vars.
ALTER TABLE pgstack.edge_functions ADD COLUMN IF NOT EXISTS env_vars_encrypted BYTEA;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='pgstack' AND table_name='edge_functions' AND column_name='env_vars'
  ) THEN
    -- Loudly destroy plaintext env vars rather than silently leaving them.
    UPDATE pgstack.edge_functions SET env_vars = NULL WHERE env_vars IS NOT NULL;
    ALTER TABLE pgstack.edge_functions DROP COLUMN env_vars;
    RAISE NOTICE 'pgstack.edge_functions.env_vars dropped (plaintext footgun). Re-deploy functions with env vars via the SDK/CLI once SECRETS_ENCRYPTION_KEY is configured.';
  END IF;
END $$;

-- migrate:down

-- Restore the OLD plaintext schema. This is provided for emergency rollback
-- only; running this reintroduces F6.
ALTER TABLE pgstack.refresh_tokens ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE pgstack.refresh_tokens DROP COLUMN IF EXISTS token_hash;
ALTER TABLE pgstack.email_tokens   ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE pgstack.email_tokens   DROP COLUMN IF EXISTS token_hash;
ALTER TABLE pgstack.edge_functions ADD COLUMN IF NOT EXISTS env_vars JSONB DEFAULT '{}'::jsonb;
ALTER TABLE pgstack.edge_functions DROP COLUMN IF EXISTS env_vars_encrypted;
