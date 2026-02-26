import React from 'react';
import { DataGrid } from '../ui/DataGrid';
import { Badge } from '../ui/Badge';
import { useUsers } from '../../hooks/useUsers';
import type { User } from '../../api/auth-api';

interface UserTableProps {
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSelectUser: (user: User) => void;
  selectedUserId?: string;
}

export function UserTable({ page, pageSize, onPageChange, onSelectUser, selectedUserId }: UserTableProps): React.ReactElement {
  const { usersQuery, countQuery } = useUsers(page, pageSize);
  const users = (usersQuery.data ?? []) as unknown as Record<string, unknown>[];
  const total = countQuery.data ?? 0;

  const columns = [
    {
      key: 'email',
      header: 'Email',
      render: (_val: unknown, row: Record<string, unknown>) => (
        <button
          onClick={() => onSelectUser(row as unknown as User)}
          className={`text-left hover:text-brand transition-colors ${
            selectedUserId === String(row['id']) ? 'text-brand' : 'text-gray-200'
          }`}
        >
          {String(row['email'])}
        </button>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (val: unknown) => <Badge variant="blue">{String(val)}</Badge>,
    },
    {
      key: 'email_confirmed_at',
      header: 'Confirmed',
      render: (val: unknown) => (
        <Badge variant={val ? 'green' : 'red'}>
          {val ? 'Yes' : 'No'}
        </Badge>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (val: unknown) => (
        <span className="text-xs">{String(val).slice(0, 10)}</span>
      ),
    },
  ];

  return (
    <DataGrid
      columns={columns}
      data={users}
      isLoading={usersQuery.isLoading}
      pagination={{ page, pageSize, total, onPageChange }}
      emptyMessage="No users found"
    />
  );
}
