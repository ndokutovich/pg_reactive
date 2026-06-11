/**
 * pg-reactive server-side admin module.
 *
 * Provides a PgReactiveAdmin class for managing live query subscriptions
 * directly in PostgreSQL. This is a Node.js-only module that requires
 * the `pg` package.
 *
 * @example
 * ```ts
 * import { PgReactiveAdmin } from "@pgstack/sdk/server";
 *
 * const admin = new PgReactiveAdmin({
 *   connectionString: "postgres://user:pass@127.0.0.1:5432/mydb",
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
  mode: string;
  status: string;
}

export interface Subscription {
  query_id: string;
  query_text: string;
  num_tables: number;
  mode: string;
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
   * Calls pgr.subscribe(query_id, sql, mode, audience).
   *
   * @param queryId - stable subscription id
   * @param sql - the SELECT to track
   * @param mode - 'delta' (default) for full diff, 'notify' for lightweight invalidation
   * @param audience - optional JWT-claim filter; when set, only WebSocket
   *   clients whose JWT contains every key/value pair receive deltas.
   *   Example: `{ sub: userId }` to scope the subscription to one user.
   *   Without this, deltas are public — anyone on the WS endpoint can see
   *   them. Audit round 28 F5: required for per-user live queries.
   */
  async register(
    queryId: string,
    sql: string,
    mode: "delta" | "notify" = "delta",
    audience?: Record<string, string>,
  ): Promise<RegisteredQuery> {
    const audienceJson = audience ? JSON.stringify(audience) : null;
    const result = await this.pool.query(
      "SELECT pgr.subscribe($1, $2, $3, $4::jsonb) AS result",
      [queryId, sql, mode, audienceJson],
    );
    const jsonb = result.rows[0].result;
    return {
      query_id: jsonb.query_id,
      tables: jsonb.tables,
      mode: jsonb.mode,
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
      "SELECT query_id, query_text, num_tables, mode FROM pgr.subscriptions ORDER BY query_id",
    );
    return result.rows.map((row) => ({
      query_id: row.query_id,
      query_text: row.query_text,
      num_tables: row.num_tables,
      mode: row.mode,
    }));
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
