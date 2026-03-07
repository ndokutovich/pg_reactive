import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DataGrid } from '../ui/DataGrid';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { listSessions, revokeSession } from '../../api/auth-api';
import { useToast } from '../ui/Toast';

interface SessionListProps {
  userId: string;
}

export function SessionList({ userId }: SessionListProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['sessions', userId],
    queryFn: () => listSessions(userId),
  });

  const handleRevoke = async (id: string) => {
    try {
      await revokeSession(id);
      showToast('Session revoked', 'success');
      void queryClient.invalidateQueries({ queryKey: ['sessions', userId] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  const columns = [
    {
      key: 'created_at',
      header: 'Created',
      render: (val: unknown) => <span className="text-xs">{String(val).slice(0, 19)}</span>,
    },
    {
      key: 'expires_at',
      header: 'Expires',
      render: (val: unknown) => <span className="text-xs">{String(val).slice(0, 19)}</span>,
    },
    {
      key: 'revoked',
      header: 'Status',
      render: (val: unknown) => (
        <Badge variant={val ? 'red' : 'green'}>{val ? 'Revoked' : 'Active'}</Badge>
      ),
    },
    {
      key: 'id',
      header: '',
      render: (_val: unknown, row: Record<string, unknown>) => (
        <Button
          size="sm"
          variant="danger"
          onClick={() => void handleRevoke(String(row['id']))}
          disabled={row['revoked'] === true}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <DataGrid
      columns={columns}
      // TS interfaces lack an index signature — assertion required for DataGrid's untyped prop
      data={(sessions ?? []) as unknown as Record<string, unknown>[]}
      isLoading={isLoading}
      emptyMessage="No sessions found"
    />
  );
}
