import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { ApiClient } from '../api/client';
import { useAuthStore } from '../store';

export function LoginPage(): React.ReactElement {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setServiceRoleKey } = useAuthStore();
  const navigate = useNavigate();

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!key.trim()) {
      setError('Service role key is required');
      return;
    }
    setLoading(true);
    try {
      const client = new ApiClient('', key.trim());
      await client.post('/api/catalog/refresh', {});
      setServiceRoleKey(key.trim());
      navigate('/table-editor');
    } catch {
      setError('Invalid key or server unreachable');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand mb-4">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="black" strokeWidth="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">pgStack Studio</h1>
          <p className="text-gray-400 mt-2 text-sm">
            Enter your Service Role Key to connect
          </p>
        </div>

        <div className="bg-surface-100 border border-surface-200 rounded-xl p-6">
          <form onSubmit={(e) => { void handleConnect(e); }} className="space-y-4">
            <Input
              label="Service Role Key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk_..."
              autoFocus
              error={error ?? undefined}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full justify-center"
              loading={loading}
            >
              Connect
            </Button>
          </form>

          <p className="mt-4 text-xs text-gray-600 text-center">
            The service role key is configured in your pgStack proxy environment variables.
          </p>
        </div>
      </div>
    </div>
  );
}
