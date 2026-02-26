import React from 'react';
import { ClientCount } from '../components/realtime/ClientCount';
import { SubscriptionTable } from '../components/realtime/SubscriptionTable';

export function RealtimePage(): React.ReactElement {
  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="max-w-sm">
        <ClientCount />
      </div>
      <div className="flex flex-col">
        <h3 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">
          Active Subscriptions
        </h3>
        <div className="bg-surface-100 border border-surface-200 rounded-lg overflow-hidden">
          <SubscriptionTable />
        </div>
      </div>
    </div>
  );
}
