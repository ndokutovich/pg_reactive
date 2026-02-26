import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ColumnList } from './ColumnList';
import { IndexList } from './IndexList';
import { FKList } from './FKList';
import { Spinner } from '../ui/Spinner';
import { listColumns, listIndexes, listFKs } from '../../api/catalog';

interface TableDetailProps {
  schema: string;
  table: string;
}

type Tab = 'columns' | 'indexes' | 'fks';

export function TableDetail({ schema, table }: TableDetailProps): React.ReactElement {
  const [tab, setTab] = useState<Tab>('columns');

  const columnsQuery = useQuery({
    queryKey: ['columns', schema, table],
    queryFn: () => listColumns(schema, table),
    staleTime: 60_000,
  });

  const indexesQuery = useQuery({
    queryKey: ['indexes', schema, table],
    queryFn: () => listIndexes(schema, table),
    staleTime: 60_000,
    enabled: tab === 'indexes',
  });

  const fksQuery = useQuery({
    queryKey: ['fks', schema, table],
    queryFn: () => listFKs(schema, table),
    staleTime: 60_000,
    enabled: tab === 'fks',
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: 'columns', label: 'Columns' },
    { key: 'indexes', label: 'Indexes' },
    { key: 'fks', label: 'Foreign Keys' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-surface-200">
        <h2 className="text-sm font-semibold text-white">
          <span className="text-gray-500">{schema}.</span>{table}
        </h2>
      </div>

      <div className="flex border-b border-surface-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'text-brand border-b-2 border-brand'
                : 'text-gray-500 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'columns' && (
          columnsQuery.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : columnsQuery.error ? (
            <p className="px-3 py-4 text-sm text-red-400">Failed to load columns</p>
          ) : (
            <ColumnList columns={columnsQuery.data ?? []} />
          )
        )}
        {tab === 'indexes' && (
          indexesQuery.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : indexesQuery.error ? (
            <p className="px-3 py-4 text-sm text-red-400">Failed to load indexes</p>
          ) : (
            <IndexList indexes={indexesQuery.data ?? []} />
          )
        )}
        {tab === 'fks' && (
          fksQuery.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : fksQuery.error ? (
            <p className="px-3 py-4 text-sm text-red-400">Failed to load foreign keys</p>
          ) : (
            <FKList fks={fksQuery.data ?? []} />
          )
        )}
      </div>
    </div>
  );
}
