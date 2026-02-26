import { useQuery } from '@tanstack/react-query';
import { listUsers, countUsers } from '../api/auth-api';

export function useUsers(page = 1, pageSize = 50) {
  const usersQuery = useQuery({
    queryKey: ['auth-users', page, pageSize],
    queryFn: () => listUsers(page, pageSize),
  });

  const countQuery = useQuery({
    queryKey: ['auth-users-count'],
    queryFn: countUsers,
  });

  return { usersQuery, countQuery };
}
