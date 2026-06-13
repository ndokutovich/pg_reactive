-- Migration: email_token_email_binding
-- Created at: 2026-06-13T13:00:00.000Z
--
-- Closes gemini audit finding 2 (P1) on existing installs: a verification token
-- was bound only to user_id, so a token minted for address X would later confirm
-- whatever the account's CURRENT email was (X -> Y). The proxy now binds each
-- email_verification token to the address it confirms and rejects it once the
-- user's email no longer matches; it also revokes outstanding verification
-- tokens on an email change.
--
-- This adds the column the proxy code requires. It MUST be applied before the
-- updated proxy starts — the new INSERT/RETURNING reference email_tokens.email.

-- migrate:up
ALTER TABLE pgstack.email_tokens ADD COLUMN IF NOT EXISTS email text;

-- migrate:down
--
-- Dropping the column reverts the proxy to user_id-only verification, which
-- re-opens finding 2 (a token confirms whatever the current email is). Only run
-- this AFTER rolling the proxy back to the pre-fix build, or /verify breaks
-- (the code references email_tokens.email).
ALTER TABLE pgstack.email_tokens DROP COLUMN IF EXISTS email;
