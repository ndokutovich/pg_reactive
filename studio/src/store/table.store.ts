import { create } from 'zustand';

export interface TableFilter {
  column: string;
  op: string;
  value: string;
}

interface TableState {
  selectedSchema: string;
  selectedTable: string | null;
  page: number;
  pageSize: number;
  filters: TableFilter[];
  sortCol: string | null;
  sortDir: 'asc' | 'desc';
  setTable: (schema: string, table: string) => void;
  setFilters: (filters: TableFilter[]) => void;
  setSort: (col: string, dir: 'asc' | 'desc') => void;
  setPage: (page: number) => void;
}

export const useTableStore = create<TableState>()((set) => ({
  selectedSchema: 'public',
  selectedTable: null,
  page: 1,
  pageSize: 50,
  filters: [],
  sortCol: null,
  sortDir: 'asc',
  setTable: (schema: string, table: string) =>
    set({ selectedSchema: schema, selectedTable: table, page: 1, filters: [] }),
  setFilters: (filters: TableFilter[]) => set({ filters, page: 1 }),
  setSort: (col: string, dir: 'asc' | 'desc') =>
    set({ sortCol: col, sortDir: dir, page: 1 }),
  setPage: (page: number) => set({ page }),
}));
