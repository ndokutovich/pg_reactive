import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PgReactiveAdmin } from "./server.js";

/**
 * Integration tests for PgReactiveAdmin.
 * Requires: docker compose db running on port 15432 with pg_reactive loaded.
 *
 * On self-hosted CI the test runs inside the runner container, which can
 * reach the db service by name on the compose network (PG_HOST=db,
 * PG_TEST_PORT=5432). Defaults preserve the local-dev workflow.
 */

const PG_HOST = process.env.PG_HOST || "127.0.0.1";
const PG_TEST_PORT = process.env.PG_TEST_PORT || "15432";
const CONNECTION_STRING =
  `postgres://postgres:postgres@${PG_HOST}:${PG_TEST_PORT}/pg_reactive_test`;

let admin: PgReactiveAdmin;

// Track query_ids registered during tests for cleanup
const registeredIds: string[] = [];

beforeAll(async () => {
  admin = new PgReactiveAdmin({ connectionString: CONNECTION_STRING });

  // Ensure extension and test table exist
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_reactive");
  await pool.query("DROP TABLE IF EXISTS sdk_test CASCADE");
  await pool.query(
    "CREATE TABLE sdk_test (id serial PRIMARY KEY, name text, val int)",
  );
  await pool.end();
});

afterEach(async () => {
  // Cleanup any registered queries
  for (const id of registeredIds) {
    try {
      await admin.unregister(id);
    } catch {
      // ignore
    }
  }
  registeredIds.length = 0;
});

afterAll(async () => {
  // Drop test table
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  await pool.query("DROP TABLE IF EXISTS sdk_test CASCADE");
  await pool.end();

  await admin.close();
});

describe("PgReactiveAdmin", () => {
  it("registers a live query", async () => {
    const result = await admin.register(
      "sdk_q1",
      "SELECT id, name FROM sdk_test",
    );
    registeredIds.push("sdk_q1");

    expect(result.query_id).toBe("sdk_q1");
    expect(result.tables).toBe(1);
    expect(result.status).toBe("subscribed");
  });

  it("lists active subscriptions", async () => {
    await admin.register("sdk_list_q", "SELECT id, val FROM sdk_test");
    registeredIds.push("sdk_list_q");

    const subs = await admin.listSubscriptions();
    const found = subs.find((s) => s.query_id === "sdk_list_q");

    expect(found).toBeDefined();
    expect(found!.query_text).toBe("SELECT id, val FROM sdk_test");
    expect(found!.num_tables).toBe(1);
  });

  it("unregisters a live query", async () => {
    await admin.register("sdk_unreg_q", "SELECT id FROM sdk_test");

    const result = await admin.unregister("sdk_unreg_q");
    expect(result).toBe(true);

    // Should not appear in subscriptions anymore
    const subs = await admin.listSubscriptions();
    const found = subs.find((s) => s.query_id === "sdk_unreg_q");
    expect(found).toBeUndefined();
  });

  it("unregister non-existent returns false", async () => {
    const result = await admin.unregister("nonexistent_q");
    expect(result).toBe(false);
  });

  it("re-register updates the subscription", async () => {
    await admin.register("sdk_reuse_q", "SELECT id FROM sdk_test");
    registeredIds.push("sdk_reuse_q");

    // Re-register with a different query
    const result = await admin.register(
      "sdk_reuse_q",
      "SELECT id, name, val FROM sdk_test",
    );
    expect(result.query_id).toBe("sdk_reuse_q");
    expect(result.status).toBe("subscribed");

    const subs = await admin.listSubscriptions();
    const found = subs.find((s) => s.query_id === "sdk_reuse_q");
    expect(found).toBeDefined();
    expect(found!.query_text).toBe("SELECT id, name, val FROM sdk_test");
  });

  it("register with invalid SQL throws", async () => {
    await expect(
      admin.register("sdk_bad_q", "NOT VALID SQL"),
    ).rejects.toThrow();
  });
});
