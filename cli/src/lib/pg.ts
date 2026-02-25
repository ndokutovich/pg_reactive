import pg from "pg";

const { Client } = pg;

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: string;
}

/**
 * Connect to PostgreSQL and return the client.
 * Caller is responsible for calling client.end().
 */
export async function connectPg(databaseUrl: string): Promise<pg.Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

/**
 * Ensure the pgstack.migrations table exists.
 */
export async function ensureMigrationsTable(
  client: pg.Client
): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS pgstack;
    CREATE TABLE IF NOT EXISTS pgstack.migrations (
      id      serial PRIMARY KEY,
      name    text UNIQUE NOT NULL,
      applied_at timestamptz DEFAULT now()
    );
  `);
}

/**
 * Get list of already-applied migrations.
 */
export async function getAppliedMigrations(
  client: pg.Client
): Promise<MigrationRecord[]> {
  const { rows } = await client.query<MigrationRecord>(
    `SELECT id, name, applied_at::text FROM pgstack.migrations ORDER BY name`
  );
  return rows;
}

/**
 * Apply a single migration inside a transaction.
 */
export async function applyMigration(
  client: pg.Client,
  name: string,
  sql: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO pgstack.migrations (name) VALUES ($1)",
      [name]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Introspect public schema tables and columns for type generation.
 */
export interface ColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: boolean;
  column_default: string | null;
}

export interface TableInfo {
  table_name: string;
  columns: ColumnInfo[];
}

export async function introspectSchema(
  client: pg.Client,
  schemas: string[] = ["public"]
): Promise<TableInfo[]> {
  const placeholders = schemas.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT
       c.table_name,
       c.column_name,
       c.data_type,
       c.udt_name,
       c.is_nullable,
       c.column_default
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema IN (${placeholders})
       AND t.table_type = 'BASE TABLE'
       AND c.table_name NOT LIKE 'pgstack_%'
     ORDER BY c.table_name, c.ordinal_position`,
    schemas
  );

  const tables = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    if (!tables.has(row.table_name)) {
      tables.set(row.table_name, []);
    }
    tables.get(row.table_name)!.push({
      column_name: row.column_name,
      data_type: row.data_type,
      udt_name: row.udt_name,
      is_nullable: row.is_nullable === "YES",
      column_default: row.column_default,
    });
  }

  return Array.from(tables.entries()).map(([table_name, columns]) => ({
    table_name,
    columns,
  }));
}

/**
 * Map PostgreSQL type to TypeScript type.
 */
export function pgTypeToTs(udtName: string, dataType: string): string {
  switch (udtName) {
    case "bool":
      return "boolean";
    case "int2":
    case "int4":
    case "int8":
    case "float4":
    case "float8":
    case "numeric":
      return "number";
    case "json":
    case "jsonb":
      return "Json";
    case "uuid":
    case "text":
    case "varchar":
    case "char":
    case "bpchar":
    case "name":
    case "citext":
      return "string";
    case "timestamptz":
    case "timestamp":
    case "date":
    case "time":
    case "timetz":
      return "string";
    case "bytea":
      return "string";
    case "inet":
    case "cidr":
    case "macaddr":
      return "string";
    default:
      if (dataType === "ARRAY") return "unknown[]";
      if (dataType === "USER-DEFINED") return "string";
      return "unknown";
  }
}
