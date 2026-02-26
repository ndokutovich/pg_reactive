import React from 'react';
import { Badge } from '../ui/Badge';
import type { IndexDef } from '../../api/catalog';

interface IndexListProps {
  indexes: IndexDef[];
}

export function IndexList({ indexes }: IndexListProps): React.ReactElement {
  if (indexes.length === 0) {
    return <p className="px-3 py-4 text-sm text-gray-500">No indexes found</p>;
  }

  return (
    <table className="w-full text-sm text-left">
      <thead>
        <tr className="border-b border-surface-200">
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Name</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Columns</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Unique</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((idx) => (
          <tr key={idx.name} className="border-b border-surface-200 hover:bg-surface-100/50">
            <td className="px-3 py-2 text-white font-mono text-xs">{idx.name}</td>
            <td className="px-3 py-2 text-gray-300 text-xs">{idx.columns.join(', ')}</td>
            <td className="px-3 py-2">
              {idx.unique ? (
                <Badge variant="green">unique</Badge>
              ) : (
                <Badge variant="gray">no</Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
