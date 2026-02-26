import React from 'react';
import { DataGrid } from '../ui/DataGrid';
import type { SqlResult } from '../../api/sql';

interface ResultsGridProps {
  result: SqlResult | null;
  isLoading: boolean;
}

export function ResultsGrid({ result, isLoading }: ResultsGridProps): React.ReactElement {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm gap-2">
        <svg className="animate-spin w-4 h-4 text-brand" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Running query...
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Run a query to see results (Ctrl+Enter)
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="p-4">
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-md">
          <p className="text-xs font-semibold text-red-400 mb-1">Query Error</p>
          <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">{result.error}</pre>
        </div>
      </div>
    );
  }

  if (result.rows_affected !== undefined) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-2xl font-bold text-brand">{result.rows_affected}</p>
          <p className="text-sm text-gray-400 mt-1">rows affected</p>
        </div>
      </div>
    );
  }

  if (result.rows) {
    const rows = result.rows;
    if (rows.length === 0) {
      return (
        <div className="flex items-center justify-center h-full text-gray-500 text-sm">
          Query returned 0 rows
        </div>
      );
    }

    const columns = Object.keys(rows[0]).map((k) => ({
      key: k,
      header: k,
      render: (val: unknown) => {
        if (val === null || val === undefined) return <span className="text-gray-600 italic">null</span>;
        if (typeof val === 'object') return <span className="font-mono text-xs">{JSON.stringify(val)}</span>;
        return <span>{String(val)}</span>;
      },
    }));

    return (
      <DataGrid
        columns={columns}
        data={rows}
        isLoading={false}
        emptyMessage="No results"
      />
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
      Query executed successfully
    </div>
  );
}
