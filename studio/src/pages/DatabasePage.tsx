import React from 'react';
import { useParams } from 'react-router-dom';
import { SchemaTree } from '../components/database/SchemaTree';
import { TableDetail } from '../components/database/TableDetail';

export function DatabasePage(): React.ReactElement {
  const params = useParams<{ schema: string; table: string }>();

  return (
    <div className="flex h-full">
      <div className="w-64 flex-shrink-0 border-r border-surface-200 overflow-hidden">
        <div className="px-3 py-2.5 border-b border-surface-200">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Schema Browser</p>
        </div>
        <SchemaTree />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        {params.schema && params.table ? (
          <TableDetail schema={params.schema} table={params.table} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Select a table to inspect its structure
          </div>
        )}
      </div>
    </div>
  );
}
