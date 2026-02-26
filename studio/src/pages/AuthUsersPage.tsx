import React, { useState } from 'react';
import { UserTable } from '../components/auth-users/UserTable';
import { UserDetailPanel } from '../components/auth-users/UserDetailPanel';
import { CreateUserModal } from '../components/auth-users/CreateUserModal';
import { Button } from '../components/ui/Button';
import type { User } from '../api/auth-api';

export function AuthUsersPage(): React.ReactElement {
  const [page, setPage] = useState(1);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-200 flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">Users</h2>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            + New User
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <UserTable
            page={page}
            pageSize={50}
            onPageChange={setPage}
            onSelectUser={setSelectedUser}
            selectedUserId={selectedUser?.id}
          />
        </div>
      </div>

      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
        />
      )}

      {showCreate && (
        <CreateUserModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
