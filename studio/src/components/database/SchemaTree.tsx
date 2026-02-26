import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTables } from '../../hooks/useTables';
import { Spinner } from '../ui/Spinner';
import type { SchemaTable } from '../../api/catalog';

function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function TableIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function groupBySchema(tables: SchemaTable[]): Record<string, SchemaTable[]> {
  const groups: Record<string, SchemaTable[]> = {};
  for (const t of tables) {
    if (!groups[t.schema]) groups[t.schema] = [];
    groups[t.schema].push(t);
  }
  return groups;
}

export function SchemaTree(): React.ReactElement {
  const { data: tables, isLoading, error } = useTables();
  const navigate = useNavigate();
  const params = useParams();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = groupBySchema(tables ?? []);

  const toggleSchema = (schema: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-20">
        <Spinner size="sm" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-red-400">Failed to load tables</div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      {Object.entries(groups).map(([schema, schemaTables]) => (
        <div key={schema}>
          <button
            onClick={() => toggleSchema(schema)}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-semibold text-gray-400 hover:text-white uppercase tracking-wider hover:bg-surface-200 transition-colors"
          >
            <ChevronIcon open={!collapsed.has(schema)} />
            {schema}
            <span className="ml-auto text-gray-500 font-normal normal-case">{schemaTables.length}</span>
          </button>
          {!collapsed.has(schema) && (
            <div>
              {schemaTables.map((t) => {
                const isSelected = params['schema'] === schema && params['table'] === t.table;
                return (
                  <button
                    key={t.table}
                    onClick={() => navigate(`/database/${schema}/${t.table}`)}
                    className={`flex items-center gap-2 w-full pl-7 pr-3 py-1.5 text-xs text-left transition-colors ${
                      isSelected
                        ? 'bg-brand/10 text-brand'
                        : 'text-gray-400 hover:text-white hover:bg-surface-200'
                    }`}
                  >
                    <TableIcon />
                    <span className="truncate">{t.table}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
