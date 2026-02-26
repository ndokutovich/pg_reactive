import React, { useState } from 'react';
import { useTableStore } from '../../store';
import { Button } from '../ui/Button';
import type { TableFilter } from '../../store';

const OP_OPTIONS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'like', label: 'LIKE' },
  { value: 'ilike', label: 'ILIKE' },
  { value: 'is', label: 'IS' },
];

interface FilterBarProps {
  columns: string[];
}

export function FilterBar({ columns }: FilterBarProps): React.ReactElement {
  const { filters, setFilters } = useTableStore();
  const [local, setLocal] = useState<TableFilter[]>(filters);

  const addFilter = () => {
    setLocal((prev) => [
      ...prev,
      { column: columns[0] ?? '', op: 'eq', value: '' },
    ]);
  };

  const removeFilter = (idx: number) => {
    setLocal((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateFilter = (idx: number, field: keyof TableFilter, value: string) => {
    setLocal((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, [field]: value } : f))
    );
  };

  const apply = () => {
    setFilters(local);
  };

  const clear = () => {
    setLocal([]);
    setFilters([]);
  };

  return (
    <div className="bg-surface-100 border-t border-surface-200 p-3 space-y-2">
      {local.map((f, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <select
            value={f.column}
            onChange={(e) => updateFilter(idx, 'column', e.target.value)}
            className="bg-surface-200 border border-surface-300 text-white rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={f.op}
            onChange={(e) => updateFilter(idx, 'op', e.target.value)}
            className="bg-surface-200 border border-surface-300 text-white rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          >
            {OP_OPTIONS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          <input
            value={f.value}
            onChange={(e) => updateFilter(idx, 'value', e.target.value)}
            placeholder="value"
            className="bg-surface-200 border border-surface-300 text-white rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand flex-1"
          />
          <button
            onClick={() => removeFilter(idx)}
            className="text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
            aria-label="Remove filter"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={addFilter}>
          + Add Filter
        </Button>
        {local.length > 0 && (
          <>
            <Button size="sm" variant="primary" onClick={apply}>
              Apply
            </Button>
            <Button size="sm" variant="danger" onClick={clear}>
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
