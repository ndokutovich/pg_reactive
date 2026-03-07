import { getApiClient } from './client';

export interface SqlResult {
  rows?: Record<string, unknown>[];
  rows_affected?: number;
  error?: string;
}

interface ApiSqlResponse {
  ok?: boolean;
  rows?: unknown;
  rows_affected?: number;
  error?: string;
}

export async function postSql(query: string): Promise<SqlResult> {
  try {
    const client = getApiClient();
    const res = await client.post<ApiSqlResponse>('/api/sql', { sql: query });
    if (!res) return { rows: [] };
    if (res.error) {
      return { error: res.error };
    }
    if (res.rows !== undefined) {
      const rows = Array.isArray(res.rows)
        ? (res.rows as Record<string, unknown>[])
        : [];
      return { rows };
    }
    if (res.rows_affected !== undefined) {
      return { rows_affected: res.rows_affected };
    }
    return { rows: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
