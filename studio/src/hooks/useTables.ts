import { useQuery } from '@tanstack/react-query';
import { listSchemaTables } from '../api/catalog';

export function useTables() {
  return useQuery({
    queryKey: ['schema-tables'],
    queryFn: listSchemaTables,
    staleTime: 30_000,
  });
}
