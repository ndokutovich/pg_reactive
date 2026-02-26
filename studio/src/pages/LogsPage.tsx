import React from 'react';
import { LogViewer } from '../components/logs/LogViewer';

export function LogsPage(): React.ReactElement {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-200 flex-shrink-0">
        <h2 className="text-sm font-semibold text-white">Active Queries</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Live view of non-idle PostgreSQL queries (refreshes every 3s)
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <LogViewer />
      </div>
    </div>
  );
}
