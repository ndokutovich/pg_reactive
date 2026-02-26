import React from 'react';
import { DataGrid } from '../ui/DataGrid';
import { useSubscriptions } from '../../hooks/useSubscriptions';

export function SubscriptionTable(): React.ReactElement {
  const { data, isLoading, error } = useSubscriptions();

  const columns = [
    {
      key: 'query_id',
      header: 'Query ID',
      width: 280,
      render: (val: unknown) => (
        <span className="font-mono text-xs text-gray-300">{String(val)}</span>
      ),
    },
    {
      key: 'query_text',
      header: 'Query',
      render: (val: unknown) => {
        const text = String(val);
        const truncated = text.length > 60 ? text.slice(0, 60) + '...' : text;
        return (
          <span
            className="font-mono text-xs text-gray-300 cursor-default"
            title={text}
          >
            {truncated}
          </span>
        );
      },
    },
    {
      key: 'invalidation_count',
      header: 'Invalidations',
      width: 120,
      render: (val: unknown) => (
        <span className="text-brand font-semibold">{String(val)}</span>
      ),
    },
  ];

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">
        Failed to load subscriptions — pgr.get_subscriptions() may not be available
      </div>
    );
  }

  return (
    <DataGrid
      columns={columns}
      data={(data ?? []) as unknown as Record<string, unknown>[]}
      isLoading={isLoading}
      emptyMessage="No active subscriptions"
    />
  );
}
