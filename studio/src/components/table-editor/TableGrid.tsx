import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DataGrid } from '../ui/DataGrid';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { FilterBar } from './FilterBar';
import { RowForm } from './RowForm';
import { useTableStore } from '../../store';
import { useTableRows } from '../../hooks/useTableRows';
import { useColumns } from '../../hooks/useColumns';
import { insertRow, updateRow, deleteRow } from '../../api/rest';
import { useToast } from '../ui/Toast';

export function TableGrid(): React.ReactElement {
  const { selectedSchema: schema, selectedTable: table, page, pageSize, filters, sortCol, sortDir, setPage } = useTableStore();
  const { rowsQuery, countQuery } = useTableRows({ schema, table, page, pageSize, filters, sortCol, sortDir });
  const { data: columns } = useColumns(schema, table);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [showFilters, setShowFilters] = useState(false);
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [insertMode, setInsertMode] = useState(false);
  const [deletingRow, setDeletingRow] = useState<Record<string, unknown> | null>(null);

  const rows = rowsQuery.data ?? [];
  const total = countQuery.data ?? 0;
  const isLoading = rowsQuery.isLoading;

  const pkCol = columns?.find((c) => c.pk)?.name ?? 'id';
  const columnKeys = rows.length > 0 ? Object.keys(rows[0]) : [];
  const filterColumns = columns?.map((c) => c.name) ?? columnKeys;

  const gridColumns = columnKeys.map((k) => ({ key: k, header: k }));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['table-rows'] });
    void queryClient.invalidateQueries({ queryKey: ['table-count'] });
  };

  const handleInsert = async (data: Record<string, unknown>) => {
    await insertRow(table!, data);
    showToast('Row inserted', 'success');
    invalidate();
  };

  const handleEdit = async (data: Record<string, unknown>) => {
    if (!editRow) return;
    await updateRow(table!, pkCol, editRow[pkCol], data);
    showToast('Row updated', 'success');
    invalidate();
  };

  const handleDelete = async (row: Record<string, unknown>) => {
    if (!window.confirm('Delete this row?')) return;
    try {
      await deleteRow(table!, pkCol, row[pkCol]);
      showToast('Row deleted', 'success');
      invalidate();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
    setDeletingRow(null);
  };

  if (!table) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Select a table from the sidebar to get started
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-surface-200 flex-shrink-0">
        <span className="text-sm font-semibold text-white">
          {schema}.{table}
        </span>
        {countQuery.isLoading ? (
          <Spinner size="sm" />
        ) : (
          <span className="text-xs text-gray-500">{total} rows</span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowFilters((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Filter {filters.length > 0 && `(${filters.length})`}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={invalidate}
            disabled={isLoading}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setInsertMode(true)}
          >
            + Insert Row
          </Button>
        </div>
      </div>

      {showFilters && <FilterBar columns={filterColumns} />}

      <div className="flex-1 min-h-0">
        <DataGrid
          columns={gridColumns}
          data={rows}
          isLoading={isLoading}
          onEdit={(row) => setEditRow(row)}
          onDelete={handleDelete}
          pagination={{ page, pageSize, total, onPageChange: setPage }}
          emptyMessage="No rows found"
        />
      </div>

      {deletingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setDeletingRow(null)}
        />
      )}

      {insertMode && columns && (
        <RowForm
          columns={columns}
          mode="insert"
          onSubmit={handleInsert}
          onClose={() => setInsertMode(false)}
        />
      )}

      {editRow && columns && (
        <RowForm
          columns={columns}
          initialData={editRow}
          mode="edit"
          onSubmit={handleEdit}
          onClose={() => setEditRow(null)}
        />
      )}
    </div>
  );
}
