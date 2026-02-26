import { useQuery } from '@tanstack/react-query';
import { selectRows, countRows } from '../api/rest';
import type { RowFilter } from '../api/rest';

interface UseTableRowsOptions {
  schema: string;
  table: string | null;
  page: number;
  pageSize: number;
  filters: RowFilter[];
  sortCol: string | null;
  sortDir: 'asc' | 'desc';
}

export function useTableRows(opts: UseTableRowsOptions) {
  const { schema, table, page, pageSize, filters, sortCol, sortDir } = opts;
  const enabled = table !== null;

  const rowsQuery = useQuery({
    queryKey: ['table-rows', schema, table, page, pageSize, filters, sortCol, sortDir],
    queryFn: () =>
      selectRows(table!, { schema, page, pageSize, filters, sortCol, sortDir }),
    enabled,
  });

  const countQuery = useQuery({
    queryKey: ['table-count', schema, table, filters],
    queryFn: () => countRows(table!, filters),
    enabled,
  });

  return { rowsQuery, countQuery };
}
