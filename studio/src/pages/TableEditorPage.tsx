import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { TableList } from '../components/table-editor/TableList';
import { TableGrid } from '../components/table-editor/TableGrid';
import { useTableStore } from '../store';

export function TableEditorPage(): React.ReactElement {
  const params = useParams<{ schema: string; table: string }>();
  const { setTable } = useTableStore();

  useEffect(() => {
    if (params.schema && params.table) {
      setTable(params.schema, params.table);
    }
  }, [params.schema, params.table, setTable]);

  return (
    <div className="flex h-full">
      <div className="w-64 flex-shrink-0 border-r border-surface-200 overflow-hidden">
        <TableList />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <TableGrid />
      </div>
    </div>
  );
}
