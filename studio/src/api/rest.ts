import { getApiClient } from './client';

export interface RowFilter {
  column: string;
  op: string;
  value: string;
}

function buildFilterParams(filters?: RowFilter[]): Record<string, string> {
  const params: Record<string, string> = {};
  if (!filters || filters.length === 0) return params;
  filters.forEach((f, i) => {
    params[`filter_col_${i}`] = f.column;
    params[`filter_op_${i}`] = f.op;
    params[`filter_val_${i}`] = f.value;
  });
  params['filter_count'] = String(filters.length);
  return params;
}

export async function selectRows(
  table: string,
  opts: {
    schema?: string;
    page?: number;
    pageSize?: number;
    filters?: RowFilter[];
    sortCol?: string | null;
    sortDir?: 'asc' | 'desc';
  }
): Promise<Record<string, unknown>[]> {
  const { schema = 'public', page = 1, pageSize = 50, filters, sortCol, sortDir = 'asc' } = opts;

  const params: Record<string, string> = {
    schema,
    page: String(page),
    page_size: String(pageSize),
  };
  if (sortCol) {
    params['sort'] = sortCol;
    params['order'] = sortDir;
  }
  Object.assign(params, buildFilterParams(filters));

  const client = getApiClient();
  const result = await client.get<Record<string, unknown>[]>(`/rest/${table}`, params);
  return Array.isArray(result) ? result : [];
}

export async function countRows(table: string, filters?: RowFilter[]): Promise<number> {
  const params: Record<string, string> = { count: 'true' };
  Object.assign(params, buildFilterParams(filters));

  const client = getApiClient();
  try {
    const result = await client.get<{ count: number } | Record<string, unknown>[]>(`/rest/${table}`, params);
    if (result && !Array.isArray(result) && typeof (result as { count: number }).count === 'number') {
      return (result as { count: number }).count;
    }
    if (Array.isArray(result)) return result.length;
    return 0;
  } catch {
    return 0;
  }
}

export async function insertRow(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = getApiClient();
  const result = await client.post<Record<string, unknown>>(`/rest/${table}`, data);
  if (!result) throw new Error(`INSERT into ${table} returned no data`);
  return result;
}

export async function updateRow(
  table: string,
  pkCol: string,
  pkVal: unknown,
  data: Record<string, unknown>
): Promise<void> {
  const client = getApiClient();
  await client.patch<void>(`/rest/${table}`, { pk_col: pkCol, pk_val: pkVal, data });
}

export async function deleteRow(
  table: string,
  pkCol: string,
  pkVal: unknown
): Promise<void> {
  const client = getApiClient();
  await client.delete<void>(`/rest/${table}`, {
    pk_col: pkCol,
    pk_val: String(pkVal),
  });
}
