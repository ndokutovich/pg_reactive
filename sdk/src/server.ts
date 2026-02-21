/**
 * pg-reactive server-side admin module.
 *
 * Provides a PgReactiveAdmin class for managing live query subscriptions
 * directly in PostgreSQL. This is a Node.js-only module that requires
 * the `pg` package.
 *
 * @example
 * ```ts
 * import { PgReactiveAdmin } from "pg-reactive-sdk/server";
 *
 * const admin = new PgReactiveAdmin({
 *   connectionString: "postgres://user:pass@localhost:5432/mydb",
 * });
 *
 * await admin.register("orders_q", "SELECT id, total FROM orders WHERE status = 'pending'");
 * const subs = await admin.listSubscriptions();
 * await admin.unregister("orders_q");
 * await admin.close();
 * ```
 */

import type { Pool as PgPool, PoolConfig } from "pg";

export interface PgReactiveAdminOptions {
  /** PostgreSQL connection string */
  connectionString: string;
}

export interface RegisteredQuery {
  query_id: string;
  tables: number;
  status: string;
}

export interface Subscription {
  query_id: string;
  query_text: string;
  num_tables: number;
}

export class PgReactiveAdmin {
  private pool: PgPool;

  constructor(options: PgReactiveAdminOptions) {
    // Dynamic import of pg to keep it as a peer dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg") as typeof import("pg");
    this.pool = new Pool({
      connectionString: options.connectionString,
    } as PoolConfig);
  }

  /**
   * Register a live query subscription in PostgreSQL.
   * Calls pgr.subscribe(query_id, sql).
   */
  async register(queryId: string, sql: string): Promise<RegisteredQuery> {
    const result = await this.pool.query(
      "SELECT pgr.subscribe($1, $2) AS result",
      [queryId, sql],
    );
    const jsonb = result.rows[0].result;
    return {
      query_id: jsonb.query_id,
      tables: jsonb.tables,
      status: jsonb.status,
    };
  }

  /**
   * Unregister a live query subscription.
   * Calls pgr.unsubscribe(query_id).
   */
  async unregister(queryId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT pgr.unsubscribe($1) AS result",
      [queryId],
    );
    return result.rows[0].result;
  }

  /**
   * List all active subscriptions.
   */
  async listSubscriptions(): Promise<Subscription[]> {
    const result = await this.pool.query(
      "SELECT query_id, query_text, num_tables FROM pgr.subscriptions ORDER BY query_id",
    );
    return result.rows.map((row) => ({
      query_id: row.query_id,
      query_text: row.query_text,
      num_tables: row.num_tables,
    }));
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
