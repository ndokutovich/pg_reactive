import React from 'react';
import type { FKDef } from '../../api/catalog';

interface FKListProps {
  fks: FKDef[];
}

export function FKList({ fks }: FKListProps): React.ReactElement {
  if (fks.length === 0) {
    return <p className="px-3 py-4 text-sm text-gray-500">No foreign keys found</p>;
  }

  return (
    <table className="w-full text-sm text-left">
      <thead>
        <tr className="border-b border-surface-200">
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">Column</th>
          <th className="px-3 py-2 text-xs font-medium text-gray-400 uppercase">References</th>
        </tr>
      </thead>
      <tbody>
        {fks.map((fk, idx) => (
          <tr key={idx} className="border-b border-surface-200 hover:bg-surface-100/50">
            <td className="px-3 py-2 text-white font-mono text-xs">{fk.column}</td>
            <td className="px-3 py-2 text-gray-300 text-xs font-mono">
              {fk.foreign_schema}.{fk.foreign_table}({fk.foreign_column})
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
