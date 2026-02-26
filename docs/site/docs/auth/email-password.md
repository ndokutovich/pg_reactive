---
title: Email & Password Auth
sidebar_position: 2
description: Sign up, sign in, and manage users with email and password authentication.
---

# Email & Password Auth

pgStack provides email/password authentication with argon2id password hashing, JWT access tokens, and rotating refresh tokens.

## SDK usage

Install the SDK:

```bash
npm install @pgstack/sdk
```

Initialize the client:

```typescript
import { createClient } from '@pgstack/sdk';

const pgstack = createClient(
  'http://127.0.0.1:8080',
  process.env.NEXT_PUBLIC_PGSTACK_ANON_KEY!,
);
```

### Sign up

```typescript
const { data, error } = await pgstack.auth.signUp({
  email: 'user@example.com',
  password: 'strongpassword123',
});

if (error) {
  console.error('Signup failed:', error.message);
} else {
  const { user, session } = data!;
  console.log('User created:', user.id);
  console.log('Access token:', session.access_token);
}
```

You can include extra user metadata at signup:

```typescript
const { data, error } = await pgstack.auth.signUp({
  email: 'user@example.com',
  password: 'strongpassword123',
  options: {
    data: {
      full_name: 'Jane Doe',
      avatar_url: 'https://example.com/avatar.jpg',
    },
  },
});
```

### Sign in

```typescript
const { data, error } = await pgstack.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'strongpassword123',
});

if (error) {
  console.error('Login failed:', error.message);
} else {
  const { user, session } = data!;
  // Store session.access_token for subsequent requests
}
```

### Get current user

```typescript
const { data: { user }, error } = await pgstack.auth.getUser();

if (user) {
  console.log(user.id);        // UUID
  console.log(user.email);     // string
  console.log(user.role);      // 'authenticated'
  console.log(user.user_metadata); // { full_name, ... }
  console.log(user.created_at);
}
```

### Get current session

```typescript
const { data: { session } } = await pgstack.auth.getSession();

if (session) {
  console.log(session.access_token);
  console.log(session.refresh_token);
  console.log(session.expires_in);  // seconds until expiry
  console.log(session.user);
}
```

### Update user

```typescript
// Update email
const { data, error } = await pgstack.auth.updateUser({
  email: 'newemail@example.com',
});

// Update password
const { data, error } = await pgstack.auth.updateUser({
  password: 'newstrongpassword456',
});

// Update metadata
const { data, error } = await pgstack.auth.updateUser({
  data: { full_name: 'Jane Smith' },
});
```

### Sign out

```typescript
const { error } = await pgstack.auth.signOut();
// Refresh token is invalidated on the server
// Access token expires naturally (short-lived)
```

### Listen for auth state changes

```typescript
const { data: { subscription } } = pgstack.auth.onAuthStateChange(
  (event, session) => {
    switch (event) {
      case 'SIGNED_IN':
        console.log('User signed in:', session?.user.email);
        break;
      case 'SIGNED_OUT':
        console.log('User signed out');
        break;
      case 'TOKEN_REFRESHED':
        console.log('Token refreshed');
        break;
      case 'USER_UPDATED':
        console.log('User updated:', session?.user);
        break;
    }
  }
);

// Unsubscribe when done
subscription.unsubscribe();
```

### Token refresh

The SDK automatically refreshes the access token 60 seconds before it expires when `autoRefreshToken: true` (the default).

You can also refresh manually:

```typescript
const { data, error } = await pgstack.auth.refreshSession();
```

## React hook

For React applications, use the `useAuth` hook from `@pgstack/sdk/react`:

```tsx
import { useAuth } from '@pgstack/sdk/react';

function App() {
  const { user, session, loading, signInWithPassword, signOut } = useAuth(
    'http://127.0.0.1:8080',
    process.env.NEXT_PUBLIC_PGSTACK_ANON_KEY!,
  );

  if (loading) return <p>Loading...</p>;

  if (!user) {
    return <LoginForm onLogin={signInWithPassword} />;
  }

  return (
    <div>
      <p>Welcome, {user.email}</p>
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}
```

The `useAuth` hook persists the session in `localStorage` and auto-refreshes tokens before expiry.

## HTTP API

You can call the auth API directly without the SDK:

### Sign up

```bash
curl -X POST http://127.0.0.1:8080/auth/v1/signup \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -d '{
    "email": "user@example.com",
    "password": "strongpassword123"
  }'
```

Response:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "expires_in": 3600,
  "token_type": "bearer",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "authenticated",
    "user_metadata": {},
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-01-01T00:00:00Z"
  }
}
```

### Sign in

```bash
curl -X POST 'http://127.0.0.1:8080/auth/v1/token?grant_type=password' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -d '{
    "email": "user@example.com",
    "password": "strongpassword123"
  }'
```

### Refresh token

```bash
curl -X POST 'http://127.0.0.1:8080/auth/v1/token?grant_type=refresh_token' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -d '{"refresh_token": "YOUR_REFRESH_TOKEN"}'
```

### Get user

```bash
curl http://127.0.0.1:8080/auth/v1/user \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'
```

## Error handling

| HTTP Status | Error | Cause |
|------------|-------|-------|
| `400` | `invalid_request` | Missing or malformed fields |
| `400` | `email_already_exists` | Signup with existing email |
| `401` | `invalid_credentials` | Wrong email/password |
| `401` | `invalid_token` | Expired or invalid JWT |
| `401` | `invalid_refresh_token` | Refresh token not found or expired |

## Password requirements

pgStack enforces a minimum password length of 8 characters. You can add your own validation in your application before calling the auth API.
