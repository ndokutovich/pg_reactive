import React from 'react';
import { useQuery } from '@tanstack/react-query';

interface HealthResponse {
  status: string;
  pg_connected: boolean;
}

export function StatusDot(): React.ReactElement {
  const { data, isError } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/health');
      return res.json() as Promise<HealthResponse>;
    },
    refetchInterval: 10_000,
  });

  const isConnected = !isError && data?.status === 'ok';

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          isConnected ? 'bg-brand' : 'bg-red-500'
        }`}
      />
      <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
    </div>
  );
}
