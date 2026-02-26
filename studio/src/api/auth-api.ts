import { postSql } from './sql';

export interface User {
  id: string;
  email: string;
  role: string;
  created_at: string;
  email_confirmed_at: string | null;
  raw_user_meta: Record<string, unknown>;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked: boolean;
}

function isUUID(val: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

export async function listUsers(page = 1, pageSize = 50): Promise<User[]> {
  const offset = (page - 1) * pageSize;
  const sql = `
    SELECT
      id::text,
      email,
      role,
      created_at::text,
      email_confirmed_at::text,
      COALESCE(raw_user_meta, '{}'::jsonb) AS raw_user_meta
    FROM pgstack.users
    ORDER BY created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    id: r['id'] as string,
    email: r['email'] as string,
    role: r['role'] as string,
    created_at: r['created_at'] as string,
    email_confirmed_at: (r['email_confirmed_at'] as string | null) ?? null,
    raw_user_meta: (r['raw_user_meta'] as Record<string, unknown>) ?? {},
  }));
}

export async function countUsers(): Promise<number> {
  const sql = `SELECT COUNT(*)::int AS count FROM pgstack.users`;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return ((result.rows?.[0]?.['count'] as number) ?? 0);
}

export async function deleteUser(id: string): Promise<void> {
  if (!isUUID(id)) throw new Error('Invalid user ID format');
  const sql = `DELETE FROM pgstack.users WHERE id = '${id}'`;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
}

export async function listSessions(userId: string): Promise<Session[]> {
  if (!isUUID(userId)) throw new Error('Invalid user ID format');
  const sql = `
    SELECT
      id::text,
      user_id::text,
      created_at::text,
      expires_at::text,
      revoked
    FROM pgstack.refresh_tokens
    WHERE user_id = '${userId}'
    ORDER BY created_at DESC
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    id: r['id'] as string,
    user_id: r['user_id'] as string,
    created_at: r['created_at'] as string,
    expires_at: r['expires_at'] as string,
    revoked: r['revoked'] as boolean,
  }));
}

export async function revokeSession(id: string): Promise<void> {
  if (!isUUID(id)) throw new Error('Invalid session ID format');
  const sql = `UPDATE pgstack.refresh_tokens SET revoked = true WHERE id = '${id}'`;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
}
