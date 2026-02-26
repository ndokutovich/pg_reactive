import React from 'react';
import { useSubscriptions } from '../../hooks/useSubscriptions';

export function ClientCount(): React.ReactElement {
  const { data, isLoading } = useSubscriptions();
  const count = data?.length ?? 0;

  return (
    <div className="bg-surface-100 border border-surface-200 rounded-lg p-6 text-center">
      {isLoading ? (
        <div className="text-4xl font-bold text-gray-500">-</div>
      ) : (
        <div className="text-5xl font-bold text-brand">{count}</div>
      )}
      <p className="text-gray-400 mt-2 text-sm">active subscriptions</p>
      <p className="text-gray-600 text-xs mt-1">refreshes every 5 seconds</p>
    </div>
  );
}
