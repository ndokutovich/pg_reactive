import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { getApiClient } from '../../api/client';
import { useToast } from '../ui/Toast';

interface CreateUserModalProps {
  onClose: () => void;
}

export function CreateUserModal({ onClose }: CreateUserModalProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }
    setLoading(true);
    try {
      const client = getApiClient();
      await client.post('/auth/v1/signup', { email, password });
      showToast('User created successfully', 'success');
      void queryClient.invalidateQueries({ queryKey: ['auth-users'] });
      void queryClient.invalidateQueries({ queryKey: ['auth-users-count'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Create New User" onClose={onClose}>
      <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          autoFocus
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Minimum 8 characters"
        />
        {error && (
          <div className="p-2 bg-red-900/30 border border-red-700/50 rounded text-red-300 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={loading}>
            Create User
          </Button>
        </div>
      </form>
    </Modal>
  );
}
