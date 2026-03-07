import React from 'react';
import { Spinner } from './Spinner';
import { Button } from './Button';

export interface DataGridColumn {
  key: string;
  header: string;
  width?: number;
  render?: (val: unknown, row: Record<string, unknown>) => React.ReactNode;
}

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}

interface DataGridProps {
  columns: DataGridColumn[];
  data: Record<string, unknown>[];
  isLoading: boolean;
  onEdit?: (row: Record<string, unknown>) => void;
  onDelete?: (row: Record<string, unknown>) => void;
  pagination?: PaginationProps;
  emptyMessage?: string;
}

export function DataGrid({
  columns,
  data,
  isLoading,
  onEdit,
  onDelete,
  pagination,
  emptyMessage = 'No data found',
}: DataGridProps): React.ReactElement {
  const hasActions = onEdit !== undefined || onDelete !== undefined;
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-sm text-left border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-100">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider border-b border-surface-200 whitespace-nowrap"
                  style={col.width ? { width: col.width } : undefined}
                >
                  {col.header}
                </th>
              ))}
              {hasActions && (
                <th className="px-3 py-2.5 text-xs font-medium text-gray-400 uppercase tracking-wider border-b border-surface-200 w-24">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td
                  colSpan={columns.length + (hasActions ? 1 : 0)}
                  className="text-center py-12 text-gray-500"
                >
                  <Spinner size="md" className="mx-auto" />
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (hasActions ? 1 : 0)}
                  className="text-center py-12 text-gray-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-surface-200 hover:bg-surface-100/50 transition-colors"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className="px-3 py-2 text-gray-200 font-mono text-xs max-w-xs overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {col.render
                        ? col.render(row[col.key], row)
                        : renderCellValue(row[col.key])}
                    </td>
                  ))}
                  {hasActions && (
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {onEdit && (
                          <button
                            onClick={() => onEdit(row)}
                            className="text-gray-400 hover:text-brand transition-colors"
                            title="Edit"
                            aria-label="Edit row"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        )}
                        {onDelete && (
                          <button
                            onClick={() => onDelete(row)}
                            className="text-gray-400 hover:text-red-400 transition-colors"
                            title="Delete"
                            aria-label="Delete row"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}

          </tbody>
        </table>
      </div>

      {pagination && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-surface-200 bg-surface-100 text-xs text-gray-400 flex-shrink-0">
          <span>
            Page {pagination.page} of {totalPages} &mdash; {pagination.total} total rows
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCellValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}
