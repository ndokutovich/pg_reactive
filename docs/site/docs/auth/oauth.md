---
title: OAuth
sidebar_position: 3
description: Configure OAuth login with Google, GitHub, Apple, Microsoft, and custom OIDC providers.
---

# OAuth

pgStack supports OAuth login with Google, GitHub, Apple, Microsoft, and any OpenID Connect provider. The proxy handles the OAuth authorization code flow — your application redirects to the provider, the provider redirects back to pgStack, and pgStack issues a JWT session.

## How it works

```
Browser                pgStack Proxy         OAuth Provider (Google/GitHub/Apple/Microsoft/OIDC)
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

### Apple

Apple Sign in uses `id_token` (JWT) instead of a userinfo endpoint. Setup requires an Apple Developer account.

1. Go to [Apple Developer](https://developer.apple.com/account/resources/identifiers/list/serviceId) and create a Services ID.
2. Enable "Sign in with Apple" and add `https://your-domain.com/auth/v1/callback` to **Return URLs**.
3. Go to Keys, create a new key with "Sign in with Apple" enabled, and download the `.p8` file.
4. Add to your `.env`:

```env
APPLE_CLIENT_ID=com.example.auth
APPLE_TEAM_ID=ABCDE12345
APPLE_KEY_ID=FGHIJ67890
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIGT...your-key...Ag==\n-----END PRIVATE KEY-----
SITE_URL=https://your-app.example.com
```

Apple uses `response_mode=form_post` — the callback is a POST, not a GET. pgStack handles both automatically.

### Microsoft

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) and register a new application.
2. Under **Authentication**, add `https://your-domain.com/auth/v1/callback` as a **Web** redirect URI.
3. Under **Certificates & secrets**, create a new client secret.
4. Add to your `.env`:

```env
MICROSOFT_CLIENT_ID=your-application-id
MICROSOFT_CLIENT_SECRET=your-client-secret
SITE_URL=https://your-app.example.com
```

The Microsoft provider uses the `/common` tenant endpoint, supporting both personal Microsoft accounts and Azure AD work/school accounts.

### Generic OIDC

Connect any OpenID Connect provider (Keycloak, Auth0, Okta, Authentik, etc.) using auto-discovery.

1. Register a new application in your OIDC provider.
2. Set the redirect URI to `https://your-domain.com/auth/v1/callback`.
3. Note the issuer URL — it must serve `/.well-known/openid-configuration`.
4. Add to your `.env`:

```env
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_ISSUER_URL=https://auth.example.com/realms/myrealm
SITE_URL=https://your-app.example.com
```

pgStack discovers the authorization, token, and userinfo endpoints automatically from the OIDC discovery document.

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
GET /auth/v1/authorize?provider=apple&redirect_to=https://your-app.com/callback
GET /auth/v1/authorize?provider=microsoft&redirect_to=https://your-app.com/callback
GET /auth/v1/authorize?provider=oidc&redirect_to=https://your-app.com/callback
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
