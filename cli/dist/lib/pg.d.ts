import pg from "pg";
export interface MigrationRecord {
    id: number;
    name: string;
    applied_at: string;
}
/**
 * Connect to PostgreSQL and return the client.
 * Caller is responsible for calling client.end().
 */
export declare function connectPg(databaseUrl: string): Promise<pg.Client>;
/**
 * Ensure the pgstack.migrations table exists.
 */
export declare function ensureMigrationsTable(client: pg.Client): Promise<void>;
/**
 * Get list of already-applied migrations.
 */
export declare function getAppliedMigrations(client: pg.Client): Promise<MigrationRecord[]>;
/**
 * Apply a single migration inside a transaction.
 */
export declare function applyMigration(client: pg.Client, name: string, sql: string): Promise<void>;
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
export declare function introspectSchema(client: pg.Client, schemas?: string[]): Promise<TableInfo[]>;
/**
 * Map PostgreSQL type to TypeScript type.
 */
export declare function pgTypeToTs(udtName: string, dataType: string): string;
