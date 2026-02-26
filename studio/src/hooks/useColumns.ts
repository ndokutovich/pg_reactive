import { useQuery } from '@tanstack/react-query';
import { listColumns } from '../api/catalog';

export function useColumns(schema: string, table: string | null) {
  return useQuery({
    queryKey: ['columns', schema, table],
    queryFn: () => listColumns(schema, table!),
    enabled: table !== null,
    staleTime: 60_000,
  });
}
