import React, { useRef, useCallback } from 'react';
import { DataGrid } from '../ui/DataGrid';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import type { Subscription } from '../../api/realtime';

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function SubscriptionTable(): React.ReactElement {
  const { data, isLoading, error, dataUpdatedAt } = useSubscriptions();

  // Track invalidation_count per query_id between polls to compute delta rate.
  const prevCountsRef = useRef<Record<string, number>>({});
  const deltaRatesRef = useRef<Record<string, number>>({});

  // On each render with fresh data, compute deltas vs previous snapshot.
  const buildDeltaRates = useCallback((rows: Subscription[]) => {
    const prev = prevCountsRef.current;
    const rates: Record<string, number> = {};
    for (const row of rows) {
      const prevCount = prev[row.query_id] ?? row.invalidation_count;
      rates[row.query_id] = Math.max(0, row.invalidation_count - prevCount);
    }
    prevCountsRef.current = Object.fromEntries(
      rows.map((r) => [r.query_id, r.invalidation_count])
    );
    deltaRatesRef.current = rates;
    return rates;
  }, []);

  const deltaRates = data ? buildDeltaRates(data) : deltaRatesRef.current;

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : null;

  const columns = [
    {
      key: 'query_id',
      header: 'Query ID',
      width: 220,
      render: (val: unknown) => (
        <span className="font-mono text-xs text-gray-300">{String(val)}</span>
      ),
    },
    {
      key: 'query_text',
      header: 'Query',
      render: (val: unknown) => {
        const text = String(val);
        const truncated = text.length > 55 ? text.slice(0, 55) + '…' : text;
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
      key: 'num_tables',
      header: 'Tables',
      width: 72,
      render: (val: unknown) => (
        <span className="text-gray-400 text-xs">{String(val)}</span>
      ),
    },
    {
      key: 'mode',
      header: 'Mode',
      width: 80,
      render: (val: unknown) => {
        const mode = String(val);
        const color = mode === 'async' ? 'text-yellow-400' : 'text-green-400';
        return <span className={`text-xs font-mono ${color}`}>{mode}</span>;
      },
    },
    {
      key: 'invalidation_count',
      header: 'Invalidations',
      width: 120,
      render: (val: unknown, row: Record<string, unknown>) => {
        const rate = deltaRates[row['query_id'] as string] ?? 0;
        return (
          <span className="text-brand font-semibold">
            {String(val)}
            {rate > 0 && (
              <span className="ml-1.5 text-xs text-green-400 font-normal">
                +{rate}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'subscribed_at',
      header: 'Age',
      width: 90,
      render: (val: unknown) => (
        <span className="text-xs text-gray-500" title={String(val)}>
          {val ? formatAge(String(val)) : '—'}
        </span>
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
    <div>
      <DataGrid
        columns={columns}
        data={(data ?? []) as unknown as Record<string, unknown>[]}
        isLoading={isLoading}
        emptyMessage="No active subscriptions"
      />
      {lastUpdated && (
        <div className="px-3 py-1.5 text-xs text-gray-600 border-t border-surface-200">
          Updated {lastUpdated} · auto-refreshes every 5s
        </div>
      )}
    </div>
  );
}
