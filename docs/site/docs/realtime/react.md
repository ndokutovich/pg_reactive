---
title: React Hooks
sidebar_position: 4
description: useLiveQuery, useAuth, and useRpc React hooks for pgStack.
---

# React Hooks

The `@pgstack/sdk/react` module (or `pg-reactive-sdk/react`) exports React hooks for live queries, auth, and RPC.

## Installation

```bash
npm install @pgstack/sdk
# React and react-dom are peer dependencies — already installed in your project
```

## `useLiveQuery()`

Subscribe to a live query and get the current snapshot:

```typescript
import { useLiveQuery } from '@pgstack/sdk/react';

function OrderList() {
  const { rows, state, error } = useLiveQuery('active_orders', {
    url: 'ws://127.0.0.1:8080',
    token: session?.access_token,
  });

  if (state === 'connecting') return <p>Connecting...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {rows.map(row => (
        <li key={String(row.id)}>
          {String(row.status)} — ${String(row.amount)}
        </li>
      ))}
    </ul>
  );
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `queryId` | `string` | The live query ID registered with `pgr.subscribe()` |
| `options` | `LiveQueryClientOptions` | WebSocket connection options (url, token, reconnect settings) |

### Return value

```typescript
interface UseLiveQueryResult {
  /** Current snapshot of query results */
  rows: ReadonlyArray<Record<string, unknown>>;

  /** WebSocket connection state */
  state: 'connecting' | 'connected' | 'disconnected';

  /** Last delta received */
  lastDelta: Delta | null;

  /** Whether an overflow occurred (you should re-fetch the full result) */
  overflow: boolean;

  /** Whether the query was invalidated (notify mode) */
  invalidated: boolean;

  /** Last error */
  error: Error | null;

  /** Force a reconnect */
  reconnect: () => void;
}
```

### Full example with overflow handling

```tsx
import { useEffect, useState } from 'react';
import { useLiveQuery } from '@pgstack/sdk/react';
import { createClient } from '@pgstack/sdk';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

function ActiveOrders() {
  const [session, setSession] = useState(null);

  useEffect(() => {
    pgstack.auth.getSession().then(({ data: { session } }) => setSession(session));
  }, []);

  const { rows, state, overflow, error, reconnect } = useLiveQuery(
    'active_orders',
    {
      url: 'ws://127.0.0.1:8080',
      token: session?.access_token,
    },
  );

  // Handle overflow by re-fetching from REST
  const [restRows, setRestRows] = useState(null);
  useEffect(() => {
    if (overflow) {
      pgstack.from('orders')
        .select('*')
        .in('status', ['pending', 'processing'])
        .then(({ data }) => setRestRows(data));
    }
  }, [overflow]);

  const displayRows = overflow && restRows ? restRows : rows;

  return (
    <div>
      <div className="status">
        {state === 'disconnected' && (
          <span>
            Disconnected.{' '}
            <button onClick={reconnect}>Reconnect</button>
          </span>
        )}
      </div>
      {error && <p className="error">Error: {error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map(row => (
            <tr key={String(row.id)}>
              <td>{String(row.id)}</td>
              <td>{String(row.status)}</td>
              <td>${String(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

## `useAuth()`

Manage authentication state with session persistence in `localStorage`:

```tsx
import { useAuth } from '@pgstack/sdk/react';

function App() {
  const {
    user,
    session,
    loading,
    signUp,
    signInWithPassword,
    signOut,
    resetPassword,
  } = useAuth('http://127.0.0.1:8080', 'your-anon-key');

  if (loading) return <div>Loading...</div>;

  if (!user) {
    return <LoginForm onLogin={signInWithPassword} />;
  }

  return (
    <div>
      <p>Logged in as {user.email}</p>
      <button onClick={signOut}>Sign out</button>
      <YourApp session={session} />
    </div>
  );
}
```

### Sign up flow

```tsx
function SignupForm() {
  const { signUp } = useAuth('http://127.0.0.1:8080', 'your-anon-key');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await signUp(email, password);
    if (error) setErrorMsg(error);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
      />
      {errorMsg && <p className="error">{errorMsg}</p>}
      <button type="submit">Sign up</button>
    </form>
  );
}
```

### Auth state reference

| Property | Type | Description |
|----------|------|-------------|
| `user` | `User \| null` | Current user, or null if not logged in |
| `session` | `Session \| null` | Current session with access/refresh tokens |
| `loading` | `boolean` | True while checking initial auth state |
| `signUp(email, password)` | `Promise<{error}>` | Create a new account |
| `signInWithPassword(email, password)` | `Promise<{error}>` | Sign in |
| `signOut()` | `Promise<void>` | Sign out and clear session |
| `resetPassword(email)` | `Promise<{error}>` | Send password reset email |

## `useRpc()`

Call a PostgreSQL RPC function and manage loading/error state:

```tsx
import { useRpc } from '@pgstack/sdk/react';

interface DashboardStats {
  total_orders: number;
  pending_orders: number;
  revenue_today: number;
}

function Dashboard() {
  const { data, loading, error, refetch } = useRpc<DashboardStats>(
    pgstack,
    'get_dashboard_stats',
  );

  if (loading) return <p>Loading stats...</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <div>
      <h2>Dashboard</h2>
      <p>Total orders: {data?.total_orders}</p>
      <p>Pending: {data?.pending_orders}</p>
      <p>Revenue today: ${data?.revenue_today?.toFixed(2)}</p>
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}
```

With parameters (auto-refetch when params change):

```tsx
function UserOrders({ userId }: { userId: string }) {
  const { data, loading } = useRpc(
    pgstack,
    'get_user_orders',
    { p_user_id: userId },  // re-fetches when userId changes
  );

  return loading ? <p>Loading...</p> : <OrderList orders={data} />;
}
```

## Best practices

**Memoize options.** The `useLiveQuery` hook recreates the WebSocket connection when `options.url` changes. If you construct the options object inline, wrap it with `useMemo`:

```tsx
import { useMemo } from 'react';

function OrderList({ token }: { token: string }) {
  const options = useMemo(() => ({
    url: 'ws://127.0.0.1:8080',
    token,
  }), [token]);

  const { rows } = useLiveQuery('active_orders', options);
  // ...
}
```

**Pass the token correctly.** Use `ws://` (not `http://`) for the WebSocket URL. The token is passed as a query parameter by the SDK.

**Handle the loading state.** On first render, `rows` is an empty array and `state` is `'connecting'`. Show a loading indicator to avoid flashing an empty list.
