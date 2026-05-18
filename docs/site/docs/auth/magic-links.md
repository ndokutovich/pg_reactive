---
title: Magic Links
sidebar_position: 4
description: Passwordless email authentication with magic links.
---

# Magic Links

Magic links let users log in without a password. The user enters their email address, receives a link by email, and clicking the link signs them in automatically.

:::info Coming Soon
Magic link authentication is planned for a future release. This page describes the intended API, which will be compatible with `@supabase/supabase-js`.
:::

## Planned API

### SDK usage

```typescript
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

// Send a magic link to the user's email
const { error } = await pgstack.auth.signInWithOtp({
  email: 'user@example.com',
  options: {
    emailRedirectTo: 'https://your-app.com/auth/callback',
  },
});

if (error) {
  console.error('Failed to send magic link:', error.message);
} else {
  // Ask user to check their email
}
```

### Verify the OTP

When the user clicks the link, they are redirected to your app with a token in the URL. The SDK handles this automatically:

```typescript
// The SDK detects the token in the URL hash on initialization
const { data: { session } } = await pgstack.auth.getSession();

if (session) {
  // User is now logged in
  console.log('Logged in as:', session.user.email);
}
```

## Requirements

Magic links require SMTP configuration. Set the following environment variables:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=noreply@your-app.com
```

See [Environment Variables](../installation#smtp--email-optional) for details.

## Workaround: OTP via email today

While magic links are not yet implemented, you can implement a similar flow yourself using PostgreSQL functions and your own email provider:

```sql
-- Store OTP tokens
CREATE TABLE auth_otps (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  used       BOOLEAN NOT NULL DEFAULT false
);

-- Generate an OTP.
--
-- SECURITY DEFINER with a pinned search_path of pg_catalog + pg_temp
-- only. Every app-schema reference is fully qualified
-- (pgstack.auth_otps) so a CREATE-on-public role cannot shadow the
-- table or any built-in (encode, gen_random_bytes, now) and run code
-- as the definer.
CREATE OR REPLACE FUNCTION pgstack.request_otp(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_token TEXT;
BEGIN
  INSERT INTO pgstack.auth_otps (email) VALUES (p_email)
  RETURNING token INTO v_token;
  RETURN v_token;
END;
$$;

-- Verify and consume an OTP.
CREATE OR REPLACE FUNCTION pgstack.verify_otp(p_email TEXT, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE pgstack.auth_otps
  SET used = true
  WHERE email = p_email
    AND token = p_token
    AND expires_at > now()
    AND used = false;
  RETURN FOUND;
END;
$$;
```

Then call these via the REST API from your server:

```typescript
// Server-side: generate OTP and send email
const { data } = await pgstack.rpc('request_otp', { p_email: email });
await sendEmail(email, 'Your login link', `Click here: /verify?token=${data}`);

// Server-side: verify OTP and issue session
const { data: valid } = await pgstack.rpc('verify_otp', { p_email: email, p_token: token });
if (valid) {
  // Sign in the user
}
```
