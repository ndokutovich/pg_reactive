/**
 * Unit tests for cli/src/commands/db.ts
 *
 * Coverage:
 *   - sanitizeBranchName (exported pure function)
 *   - db branch <name>         — CREATE DATABASE ... TEMPLATE
 *   - db branch --delete <name>— DROP DATABASE
 *   - db checkout <name>       — .env DATABASE_URL rewrite
 *
 * Database I/O is fully mocked; file I/O for checkout uses a real temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

// ---- Hoisted mock functions ------------------------------------------------
// vi.hoisted runs before module imports, so vi.fn() calls here are safe to
// reference inside vi.mock() factories.

const mocks = vi.hoisted(() => ({
  findProjectRoot: vi.fn<() => string | null>(),
  getDatabaseUrl: vi.fn<() => string>(),
  parseDatabaseName: vi.fn<() => string>(),
  connectPg: vi.fn(),
  ensureMigrationsTable: vi.fn(),
  applyMigration: vi.fn(),
}));

// ---- Module mocks ----------------------------------------------------------

vi.mock("../lib/config.js", () => ({
  findProjectRoot: mocks.findProjectRoot,
  getDatabaseUrl: mocks.getDatabaseUrl,
  parseDatabaseName: mocks.parseDatabaseName,
}));

vi.mock("../lib/pg.js", () => ({
  connectPg: mocks.connectPg,
  ensureMigrationsTable: mocks.ensureMigrationsTable,
  applyMigration: mocks.applyMigration,
}));

// ora spinner — silence output in tests
vi.mock("ora", () => ({
  default: () => ({
    start: () => ({ succeed: vi.fn(), fail: vi.fn(), text: "" }),
    succeed: vi.fn(),
    fail: vi.fn(),
    text: "",
  }),
}));

// chalk — return plain strings so output assertions are readable
vi.mock("chalk", () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// ---- Imports of the module under test (after mocks are declared) -----------

import { sanitizeBranchName, registerDbCommand } from "./db.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal fake pg Client. query() records every call and returns
 * stubbed rows for any text that contains a registered pattern substring.
 */
function makeFakeClient(
  queryResponses: Record<string, { rows: unknown[] }> = {},
) {
  const calls: Array<{ text: string; params: unknown[] }> = [];

  const query = vi.fn(
    async (textOrConfig: string | { text: string }, params?: unknown[]) => {
      const raw =
        typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
      const normalised = raw.replace(/\s+/g, " ").trim();
      calls.push({ text: normalised, params: params ?? [] });

      for (const [pattern, response] of Object.entries(queryResponses)) {
        if (normalised.includes(pattern)) return response;
      }
      return { rows: [] };
    },
  );

  return {
    query,
    end: vi.fn(async () => undefined),
    calls,
  };
}

type FakeClient = ReturnType<typeof makeFakeClient>;

/**
 * Register db commands on a fresh Commander instance, parse the given argv,
 * and capture console output and any explicit process.exit code.
 * process.exit is replaced with a throw so tests can catch failures cleanly.
 */
async function runDbCommand(
  argv: string[],
  fakeClient: FakeClient,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  mocks.connectPg.mockResolvedValue(fakeClient as never);

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => stdoutLines.push(args.join(" "));
  console.error = (...args: unknown[]) => stderrLines.push(args.join(" "));

  let exitCode: number | null = null;
  const origExit = process.exit.bind(process);
  (process as unknown as { exit: (c?: number) => never }).exit = (
    code?: number,
  ) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };

  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit itself
  registerDbCommand(program);

  try {
    await program.parseAsync(["node", "pgstack", ...argv]);
  } catch {
    // absorb both process.exit throws and commander ExitOverrideError
  } finally {
    console.log = origLog;
    console.error = origError;
    (process as unknown as { exit: (c?: number) => never }).exit = origExit;
  }

  return {
    exitCode,
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
  };
}

// ============================================================================
// sanitizeBranchName — pure unit tests (no I/O)
// ============================================================================

describe("sanitizeBranchName", () => {
  it("passes through a clean alphanumeric name unchanged", () => {
    expect(sanitizeBranchName("feature1")).toBe("feature1");
  });

  it("passes through names with underscores and hyphens", () => {
    expect(sanitizeBranchName("feature_branch-v2")).toBe("feature_branch-v2");
  });

  it("strips spaces", () => {
    expect(sanitizeBranchName("my branch")).toBe("mybranch");
  });

  it("strips dots", () => {
    expect(sanitizeBranchName("v1.2.3")).toBe("v123");
  });

  it("strips slashes (e.g. git-style branch names)", () => {
    expect(sanitizeBranchName("feature/login")).toBe("featurelogin");
  });

  it("strips all non-alphanumeric-underscore-hyphen characters", () => {
    expect(sanitizeBranchName("foo@bar!baz#qux")).toBe("foobarbazqux");
  });

  it("strips leading and trailing special characters", () => {
    expect(sanitizeBranchName("!!!hello!!!")).toBe("hello");
  });

  it("preserves uppercase letters", () => {
    expect(sanitizeBranchName("MyBranch")).toBe("MyBranch");
  });

  it("keeps digits-only names", () => {
    expect(sanitizeBranchName("123")).toBe("123");
  });

  it("returns only the valid portion when surrounded by special chars", () => {
    expect(sanitizeBranchName("$$valid_name$$")).toBe("valid_name");
  });

  it("throws for an empty string", () => {
    expect(() => sanitizeBranchName("")).toThrow("Invalid branch name");
  });

  it("throws when the entire name consists of invalid characters", () => {
    expect(() => sanitizeBranchName("@@@")).toThrow("Invalid branch name");
  });

  it("throws for a name made entirely of dots and slashes", () => {
    expect(() => sanitizeBranchName("./../")).toThrow("Invalid branch name");
  });
});

// ============================================================================
// db branch <name>  — CREATE DATABASE ... TEMPLATE
// ============================================================================

describe("db branch (create)", () => {
  const BASE_URL =
    "postgres://postgres:postgres@127.0.0.1:15432/myapp";

  beforeEach(() => {
    mocks.findProjectRoot.mockReturnValue("/fake/project");
    mocks.getDatabaseUrl.mockReturnValue(BASE_URL);
    mocks.parseDatabaseName.mockReturnValue("myapp");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects to the admin (postgres) database, not the app database", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "feat-x"], client);

    const [firstCallUrl] = mocks.connectPg.mock.calls[0] as [string];
    expect(firstCallUrl).toContain("/postgres");
    expect(firstCallUrl).not.toMatch(/\/myapp$/);
  });

  it("terminates existing connections to the template DB before cloning", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "feat-x"], client);

    const terminateCall = client.calls.find(
      (c) =>
        c.text.includes("pg_terminate_backend") &&
        c.text.includes("pg_stat_activity"),
    );
    expect(terminateCall).toBeDefined();
    // Must filter by the current (template) db name
    expect(terminateCall?.params).toContain("myapp");
  });

  it("issues CREATE DATABASE ... TEMPLATE with the sanitized branch name", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "feat-x"], client);

    const createCall = client.calls.find((c) =>
      c.text.toUpperCase().includes("CREATE DATABASE"),
    );
    expect(createCall).toBeDefined();
    expect(createCall?.text).toContain('"feat-x"');
    expect(createCall?.text.toUpperCase()).toContain("TEMPLATE");
    expect(createCall?.text).toContain('"myapp"');
  });

  it("sanitizes the branch name before using it in SQL", async () => {
    const client = makeFakeClient();
    // "feat/login" should become "featlogin"
    await runDbCommand(["db", "branch", "feat/login"], client);

    const createCall = client.calls.find((c) =>
      c.text.toUpperCase().includes("CREATE DATABASE"),
    );
    expect(createCall?.text).toContain('"featlogin"');
    expect(createCall?.text).not.toContain("/");
  });

  it("ends the pg client connection after the operation", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "feat-x"], client);
    expect(client.end).toHaveBeenCalled();
  });

  it("exits with code 1 when project root is not found", async () => {
    mocks.findProjectRoot.mockReturnValue(null);
    const client = makeFakeClient();
    const { exitCode } = await runDbCommand(["db", "branch", "feat-x"], client);
    expect(exitCode).toBe(1);
  });

  it("does not issue any SQL when the branch name has no valid characters", async () => {
    // sanitizeBranchName throws before the try/catch that wraps connectPg,
    // so no SQL is ever issued.
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "@@@"], client);
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ============================================================================
// db branch --delete <name>  — DROP DATABASE
// ============================================================================

describe("db branch --delete", () => {
  const BASE_URL =
    "postgres://postgres:postgres@127.0.0.1:15432/myapp";

  beforeEach(() => {
    mocks.findProjectRoot.mockReturnValue("/fake/project");
    mocks.getDatabaseUrl.mockReturnValue(BASE_URL);
    mocks.parseDatabaseName.mockReturnValue("myapp");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("terminates connections to the branch database before dropping", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "--delete", "feat-x"], client);

    const terminateCall = client.calls.find((c) =>
      c.text.includes("pg_terminate_backend"),
    );
    expect(terminateCall).toBeDefined();
    expect(terminateCall?.params).toContain("feat-x");
  });

  it("issues DROP DATABASE IF EXISTS with the sanitized branch name", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "--delete", "feat-x"], client);

    const dropCall = client.calls.find((c) =>
      c.text.toUpperCase().includes("DROP DATABASE"),
    );
    expect(dropCall).toBeDefined();
    expect(dropCall?.text).toContain('"feat-x"');
    expect(dropCall?.text.toUpperCase()).toContain("IF EXISTS");
  });

  it("does NOT issue CREATE DATABASE when --delete flag is set", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "--delete", "feat-x"], client);

    const createCall = client.calls.find((c) =>
      c.text.toUpperCase().includes("CREATE DATABASE"),
    );
    expect(createCall).toBeUndefined();
  });

  it("sanitizes the branch name before the DROP", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "--delete", "feat/login"], client);

    const dropCall = client.calls.find((c) =>
      c.text.toUpperCase().includes("DROP DATABASE"),
    );
    expect(dropCall?.text).toContain('"featlogin"');
  });

  it("ends the client after deletion", async () => {
    const client = makeFakeClient();
    await runDbCommand(["db", "branch", "--delete", "feat-x"], client);
    expect(client.end).toHaveBeenCalled();
  });
});

// ============================================================================
// db checkout <name>  — .env DATABASE_URL rewrite
// ============================================================================

describe("db checkout", () => {
  let tempDir: string;
  const BASE_URL =
    "postgres://postgres:postgres@127.0.0.1:15432/myapp";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pgstack-db-test-"));
    writeFileSync(
      join(tempDir, "pgstack.config.json"),
      JSON.stringify({ projectName: "test" }),
    );

    mocks.findProjectRoot.mockReturnValue(tempDir);
    mocks.getDatabaseUrl.mockReturnValue(BASE_URL);
    mocks.parseDatabaseName.mockReturnValue("myapp");
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies the branch database exists via pg_database query", async () => {
    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    await runDbCommand(["db", "checkout", "feat-x"], client);

    const existsCall = client.calls.find(
      (c) => c.text.includes("pg_database") && c.text.includes("datname"),
    );
    expect(existsCall).toBeDefined();
    expect(existsCall?.params).toContain("feat-x");
  });

  it("exits with code 1 when the branch database does not exist", async () => {
    // Empty rows — database not found
    const client = makeFakeClient({ pg_database: { rows: [] } });
    const { exitCode } = await runDbCommand(
      ["db", "checkout", "nonexistent"],
      client,
    );
    expect(exitCode).toBe(1);
  });

  it("creates .env with DATABASE_URL when no .env file exists", async () => {
    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    const { stdout } = await runDbCommand(["db", "checkout", "feat-x"], client);

    const envPath = join(tempDir, ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/feat-x",
    );
    // Kill mutants: assert on success messages (lines 249-250)
    expect(stdout).toContain("Switched to branch");
    expect(stdout).toContain("DATABASE_URL updated");
  });

  it("replaces existing DATABASE_URL line when .env already has one", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      "JWT_SECRET=abc123\nDATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/myapp\nSOME_KEY=value\n",
      "utf-8",
    );

    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    await runDbCommand(["db", "checkout", "feat-x"], client);

    const content = readFileSync(envPath, "utf-8");
    // New URL present
    expect(content).toContain(
      "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/feat-x",
    );
    // Old URL gone
    expect(content).not.toContain("/myapp");
    // Other keys preserved
    expect(content).toContain("JWT_SECRET=abc123");
    expect(content).toContain("SOME_KEY=value");
    // Exactly one DATABASE_URL line
    const matches = content.match(/^DATABASE_URL=/gm);
    expect(matches?.length).toBe(1);
  });

  it("appends DATABASE_URL when .env exists but has no DATABASE_URL entry", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "JWT_SECRET=abc123\n", "utf-8");

    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    await runDbCommand(["db", "checkout", "feat-x"], client);

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("JWT_SECRET=abc123");
    expect(content).toContain(
      "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/feat-x",
    );
  });

  it("uses the sanitized branch name in the written URL", async () => {
    // "feat/login" -> "featlogin"
    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    await runDbCommand(["db", "checkout", "feat/login"], client);

    const envPath = join(tempDir, ".env");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("/featlogin");
    expect(content).not.toContain("feat/login");
  });

  it("preserves the protocol, credentials, host, and port in the rewritten URL", async () => {
    const client = makeFakeClient({
      pg_database: { rows: [{ "?column?": 1 }] },
    });
    await runDbCommand(["db", "checkout", "feat-x"], client);

    const envPath = join(tempDir, ".env");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "postgres://postgres:postgres@127.0.0.1:15432/feat-x",
    );
  });

  it("exits with code 1 when project root is not found", async () => {
    mocks.findProjectRoot.mockReturnValue(null);
    const client = makeFakeClient();
    const { exitCode } = await runDbCommand(
      ["db", "checkout", "feat-x"],
      client,
    );
    expect(exitCode).toBe(1);
  });

  it("does not write .env and issues no SQL when branch name has no valid characters", async () => {
    // sanitizeBranchName throws before the try/catch that calls connectPg
    const client = makeFakeClient();
    await runDbCommand(["db", "checkout", "@@@"], client);
    expect(client.query).not.toHaveBeenCalled();
    expect(existsSync(join(tempDir, ".env"))).toBe(false);
  });
});
