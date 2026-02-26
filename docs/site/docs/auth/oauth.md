---
title: OAuth
sidebar_position: 3
description: Configure Google and GitHub OAuth login with pgStack.
---

# OAuth

pgStack supports OAuth login with Google and GitHub. The proxy handles the OAuth authorization code flow — your application redirects to the provider, the provider redirects back to pgStack, and pgStack issues a JWT session.

## How it works

```
Browser                pgStack Proxy         OAuth Provider (Google/GitHub)
   │                        │                         │
   ├─ GET /auth/v1/authorize?provider=google ─►│       │
   │                        ├─ 302 redirect ──────────►│
   │◄────────────────────────────────────────────────  │
   ├─ user logs in at provider ──────────────────────►│
   │                        │◄── callback with code ──┤
   │                        ├─ exchange code for tokens │
   │                        ├─ upsert user in pgstack.users
   │◄── 302 redirect to SITE_URL#access_token=... ─── │
   │ (hash fragment contains access_token + refresh_token)
```

After the redirect, your application reads the tokens from the URL hash fragment. The SDK's `handleOAuthRedirect()` method does this automatically.

## Setup

### Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create a new OAuth 2.0 Client ID (Web application).
3. Add `https://your-domain.com/auth/v1/callback` to **Authorized redirect URIs**.
4. Copy the Client ID and Client Secret to your `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
SITE_URL=https://your-app.example.com
```

For local development, add `http://127.0.0.1:8080/auth/v1/callback` to the authorized redirect URIs and set:

```env
SITE_URL=http://127.0.0.1:3000
```

### GitHub

1. Go to [GitHub Settings > Developer Settings > OAuth Apps](https://github.com/settings/developers).
2. Create a new OAuth App.
3. Set **Authorization callback URL** to `https://your-domain.com/auth/v1/callback`.
4. Copy the Client ID and Client Secret:

```env
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
SITE_URL=https://your-app.example.com
```

Restart the proxy after changing environment variables:

```bash
docker compose up -d proxy
```

## SDK usage

### Sign in with OAuth

```typescript
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

// Redirects the browser to the OAuth provider
await pgstack.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'http://127.0.0.1:3000/auth/callback',
  },
});
```

### Handle the OAuth redirect

After the OAuth flow completes, the provider redirects back to your `SITE_URL` with tokens in the URL hash:

```
http://127.0.0.1:3000/#access_token=eyJ...&refresh_token=dGh...&expires_in=3600&token_type=bearer
```

Call `handleOAuthRedirect()` to parse these tokens and establish the session. The SDK calls this automatically on initialization if `detectSessionInUrl: true` (the default), but you can also call it manually on your callback page:

```typescript
// pages/auth/callback.tsx (Next.js example)
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    pgstack.auth.handleOAuthRedirect().then(({ session, error }) => {
      if (error) {
        console.error('OAuth error:', error.message);
        router.push('/login?error=oauth_failed');
        return;
      }
      if (session) {
        console.log('Logged in as:', session.user.email);
        router.push('/dashboard');
      }
    });
  }, []);

  return <p>Completing login...</p>;
}
```

### Listen for OAuth sign-in

```typescript
pgstack.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) {
    // User signed in via OAuth (or email/password)
    console.log('Provider:', session.user.user_metadata.provider);
    console.log('Email:', session.user.email);
  }
});
```

## React example

```tsx
import { createClient } from '@pgstack/sdk';

const pgstack = createClient(
  process.env.NEXT_PUBLIC_PGSTACK_URL!,
  process.env.NEXT_PUBLIC_PGSTACK_ANON_KEY!,
);

function LoginPage() {
  const handleGoogleLogin = async () => {
    await pgstack.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  const handleGithubLogin = async () => {
    await pgstack.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  return (
    <div>
      <button onClick={handleGoogleLogin}>Sign in with Google</button>
      <button onClick={handleGithubLogin}>Sign in with GitHub</button>
    </div>
  );
}
```

## HTTP API

Initiate the OAuth flow by redirecting the user to:

```
GET /auth/v1/authorize?provider=google&redirect_to=https://your-app.com/callback
GET /auth/v1/authorize?provider=github&redirect_to=https://your-app.com/callback
```

The proxy handles the callback at `/auth/v1/callback` — do not set this as your application's redirect URL. Set your `SITE_URL` instead.

## User metadata

After OAuth login, the user's `user_metadata` includes provider information:

```json
{
  "provider": "google",
  "provider_id": "1234567890",
  "full_name": "Jane Doe",
  "avatar_url": "https://lh3.googleusercontent.com/..."
}
```

## Troubleshooting

**Redirect URI mismatch.** Ensure the URI registered in the OAuth provider settings exactly matches `https://your-domain.com/auth/v1/callback`. A trailing slash or different scheme will cause an error.

**SITE_URL not set.** After OAuth, the proxy redirects to `SITE_URL` with the session tokens. If this is not set, the user won't be redirected back to your app.

**Tokens not appearing in the hash.** If your app handles routing at the root path (SPAs), make sure your router doesn't strip the hash fragment before `handleOAuthRedirect()` runs.
