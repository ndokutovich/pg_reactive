import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SessionList } from './SessionList';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { deleteUser } from '../../api/auth-api';
import { useToast } from '../ui/Toast';
import type { User } from '../../api/auth-api';

interface UserDetailPanelProps {
  user: User;
  onClose: () => void;
}

type Tab = 'sessions' | 'metadata';

export function UserDetailPanel({ user, onClose }: UserDetailPanelProps): React.ReactElement {
  const [tab, setTab] = useState<Tab>('sessions');
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const handleDelete = async () => {
    if (!window.confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteUser(user.id);
      showToast('User deleted', 'success');
      void queryClient.invalidateQueries({ queryKey: ['auth-users'] });
      void queryClient.invalidateQueries({ queryKey: ['auth-users-count'] });
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-80 flex-shrink-0 bg-surface-100 border-l border-surface-200 flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
        <span className="text-sm font-semibold text-white">User Details</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="p-4 border-b border-surface-200 space-y-3">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">ID</p>
          <p className="text-xs font-mono text-gray-300 break-all">{user.id}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Email</p>
          <p className="text-sm text-white">{user.email}</p>
        </div>
        <div className="flex items-center gap-3">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Role</p>
            <Badge variant="blue">{user.role}</Badge>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Email Confirmed</p>
            <Badge variant={user.email_confirmed_at ? 'green' : 'red'}>
              {user.email_confirmed_at ? 'Yes' : 'No'}
            </Badge>
          </div>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Created</p>
          <p className="text-xs text-gray-300">{user.created_at.slice(0, 19)}</p>
        </div>
      </div>

      <div className="flex border-b border-surface-200">
        {(['sessions', 'metadata'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-xs font-medium capitalize transition-colors ${
              tab === t
                ? 'text-brand border-b-2 border-brand'
                : 'text-gray-500 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        {tab === 'sessions' && <SessionList userId={user.id} />}
        {tab === 'metadata' && (
          <div className="p-4">
            <pre className="text-xs font-mono text-gray-300 bg-surface-200 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap">
              {JSON.stringify(user.raw_user_meta, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-surface-200">
        <Button
          variant="danger"
          size="sm"
          className="w-full justify-center"
          loading={deleting}
          onClick={() => void handleDelete()}
        >
          Delete User
        </Button>
      </div>
    </div>
  );
}
