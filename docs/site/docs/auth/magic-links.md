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

Everything lives in `public.*`. The REST endpoint at
`/rest/v1/rpc/{fn}` walks `pg_proc` in the `public` schema only, so
functions placed elsewhere (e.g. `pgstack.*`) are unreachable via RPC
and would force you back into raw SQL. Both helpers below carry an
explicit `GRANT EXECUTE` because the bootstrap default-denies
`PUBLIC EXECUTE` on functions — without the grant the RPC call
returns "permission denied for function".

```sql
-- Store OTP tokens (in public so the helpers below can write to it
-- while running with their pinned pg_catalog,pg_temp search_path).
CREATE TABLE IF NOT EXISTS public.auth_otps (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  used       BOOLEAN NOT NULL DEFAULT false
);

-- Generate an OTP.
--
-- SECURITY DEFINER with a pinned search_path of pg_catalog + pg_temp
-- only. Every app object is fully qualified (public.auth_otps) so a
-- CREATE-on-public role cannot shadow the table or any built-in
-- (encode, gen_random_bytes, now) and run code as the definer.
CREATE OR REPLACE FUNCTION public.request_otp(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_token TEXT;
BEGIN
  INSERT INTO public.auth_otps (email) VALUES (p_email)
  RETURNING token INTO v_token;
  RETURN v_token;
END;
$$;

-- Verify and consume an OTP.
CREATE OR REPLACE FUNCTION public.verify_otp(p_email TEXT, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.auth_otps
  SET used = true
  WHERE email = p_email
    AND token = p_token
    AND expires_at > now()
    AND used = false;
  RETURN FOUND;
END;
$$;

-- ⚠️  service_role ONLY — these functions are NOT safe for the
--     authenticated browser client.
--
-- request_otp returns the raw OTP token in its result. Granting it
-- to `authenticated` would let any logged-in user call
--    POST /rest/v1/rpc/request_otp { p_email: "victim@example.com" }
-- and read back the OTP for the victim's account, bypassing the
-- email delivery channel entirely — that is a complete account
-- takeover. Same applies to verify_otp: a client that can guess or
-- brute-force tokens for arbitrary emails would short-circuit the
-- whole flow.
--
-- These helpers MUST be called only from a server-side process
-- holding SERVICE_ROLE_KEY (your Next.js / Express / Workers
-- backend) that has already authenticated the requesting user via
-- its own session and authorised that THIS user may receive an OTP
-- for THIS email. The raw OTP token must never travel back to the
-- browser; only the success/failure outcome of verify_otp does.
REVOKE EXECUTE ON FUNCTION public.request_otp(TEXT)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_otp(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.request_otp(TEXT)      TO service_role;
GRANT  EXECUTE ON FUNCTION public.verify_otp(TEXT, TEXT) TO service_role;
```

Call these from your server-side code using a client constructed
with the **SERVICE_ROLE_KEY** (never the anon key). Browser code
must never call these endpoints directly — it would be calling them
as `authenticated` and the GRANT above explicitly refuses:

```typescript
// Server-side ONLY — uses SERVICE_ROLE_KEY, not the anon key.
// Initialise this client in your backend bootstrap and never expose
// the key to the browser bundle.
const pgstackAdmin = createClient(PGSTACK_URL, process.env.SERVICE_ROLE_KEY!);

// 1. The server authenticates the requesting user from its own session
//    and decides whether to send an OTP to that email.
const { data: token } = await pgstackAdmin.rpc('request_otp', { p_email: email });

// 2. The raw token is delivered ONLY via the side channel (email).
//    Never include `token` in the response to the browser.
await sendEmail(email, 'Your login link', `Click here: /verify?token=${token}`);

// 3. When the user clicks through, your server (still SERVICE_ROLE_KEY)
//    verifies the token and issues its own session cookie. The browser
//    sees a redirect, never the token, never the boolean directly.
const { data: valid } = await pgstackAdmin.rpc('verify_otp', { p_email: email, p_token: token });
if (valid) {
  // issue server-managed session
}
```

### Production-quality variant: keep the token inside Postgres

The snippet above returns the raw OTP out of `request_otp()` so the
example fits in a single page. That's acceptable as an internal
helper called only by a server holding `SERVICE_ROLE_KEY` — there is
no role boundary between the function and the caller. But if you
turn this pattern into a real product feature (a `/auth/v1/otp/send`
endpoint, say), the token should never leave Postgres in any code
path that's reachable from the network. Two stronger shapes:

1. **Function emits the email itself.** Have `request_otp()` insert
   the row, then `pg_notify('email_outbox', json_build_object(...))`.
   A small worker (in the proxy, in DBOS, or any LISTENer) consumes
   the channel and calls the SMTP provider. The function returns a
   bare boolean — never the token. A leaky log line or a forgotten
   `RETURNS TEXT` no longer hands an attacker an OTP.

2. **Function returns an opaque receipt-id, not the secret.** If you
   need a synchronous response (e.g. for a rate-limit decision in
   the same request), return `RETURNS uuid` (the receipt id). The
   caller logs the receipt-id alongside the user's session id for
   audit; the raw token still goes out via the email outbox above.

Both shapes preserve the "raw token only ever exists in the email"
property even when the function call site is broader than the
admin-only helpers shown here.
