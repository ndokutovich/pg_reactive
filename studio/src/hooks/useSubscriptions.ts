import { useQuery } from '@tanstack/react-query';
import { listSubscriptions } from '../api/realtime';

export function useSubscriptions() {
  return useQuery({
    queryKey: ['subscriptions'],
    queryFn: listSubscriptions,
    refetchInterval: 5_000,
  });
}
