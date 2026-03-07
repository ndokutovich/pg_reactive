import { postSql } from './sql';

export interface SchemaTable {
  schema: string;
  table: string;
  kind: string;
  comment: string | null;
}

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  pk: boolean;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface FKDef {
  column: string;
  foreign_schema: string;
  foreign_table: string;
  foreign_column: string;
}

export async function listSchemaTables(): Promise<SchemaTable[]> {
  const sql = `
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized_view'
        WHEN 'f' THEN 'foreign_table'
        ELSE c.relkind::text
      END AS kind,
      obj_description(c.oid) AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','v','m','f')
      AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
    ORDER BY n.nspname, c.relname
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  // postSql returns Record<string, unknown>[] — assert the shape we know the query produces
  return (result.rows ?? []) as unknown as SchemaTable[];
}

export async function listColumns(schema: string, table: string): Promise<ColumnDef[]> {
  const sql = `
    SELECT
      c.column_name AS name,
      c.udt_name AS type,
      (c.is_nullable = 'YES') AS nullable,
      c.column_default AS default,
      COALESCE(
        (SELECT true FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
            AND kcu.table_name = tc.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
          LIMIT 1
        ), false
      ) AS pk
    FROM information_schema.columns c
    WHERE c.table_schema = '${schema.replace(/'/g, "''")}'
      AND c.table_name = '${table.replace(/'/g, "''")}'
    ORDER BY c.ordinal_position
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    name: r['name'] as string,
    type: r['type'] as string,
    nullable: r['nullable'] as boolean,
    default: (r['default'] as string | null) ?? null,
    pk: r['pk'] as boolean,
  }));
}

export async function listIndexes(schema: string, table: string): Promise<IndexDef[]> {
  const sql = `
    SELECT
      i.relname AS name,
      array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
      ix.indisunique AS unique
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = '${schema.replace(/'/g, "''")}'
      AND t.relname = '${table.replace(/'/g, "''")}'
    GROUP BY i.relname, ix.indisunique
    ORDER BY i.relname
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    name: r['name'] as string,
    columns: r['columns'] as string[],
    unique: r['unique'] as boolean,
  }));
}

export async function listFKs(schema: string, table: string): Promise<FKDef[]> {
  const sql = `
    SELECT
      kcu.column_name AS column,
      ccu.table_schema AS foreign_schema,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${schema.replace(/'/g, "''")}'
      AND tc.table_name = '${table.replace(/'/g, "''")}'
    ORDER BY kcu.column_name
  `;
  const result = await postSql(sql);
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    column: r['column'] as string,
    foreign_schema: r['foreign_schema'] as string,
    foreign_table: r['foreign_table'] as string,
    foreign_column: r['foreign_column'] as string,
  }));
}
