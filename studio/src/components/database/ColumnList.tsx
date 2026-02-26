import React from 'react';
import { Badge } from '../ui/Badge';
import type { ColumnDef } from '../../api/catalog';

interface ColumnListProps {
  columns: ColumnDef[];
}

export function ColumnList({ columns }: ColumnListProps): React.ReactElement {
  return (
    <table className="w-full text-sm text-left">
      <thead>
        <tr className="border-b border-surface-200">
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Name</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Type</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Nullable</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Default</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">PK</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((col) => (
          <tr key={col.name} className="border-b border-surface-200 hover:bg-surface-100/50">
            <td className="px-3 py-2 text-white font-mono text-xs">{col.name}</td>
            <td className="px-3 py-2">
              <Badge variant="blue">{col.type}</Badge>
            </td>
            <td className="px-3 py-2">
              {col.nullable ? (
                <Badge variant="yellow">nullable</Badge>
              ) : (
                <Badge variant="gray">not null</Badge>
              )}
            </td>
            <td className="px-3 py-2 text-gray-500 font-mono text-xs">
              {col.default ?? <span className="italic text-gray-600">none</span>}
            </td>
            <td className="px-3 py-2">
              {col.pk && <Badge variant="green">PK</Badge>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
