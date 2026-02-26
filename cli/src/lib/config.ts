import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

export interface PgStackConfig {
  projectName: string;
  dbPort: number;
  proxyPort: number;
  pgVersion: string;
  schemas: string[];
}

const DEFAULT_CONFIG: PgStackConfig = {
  projectName: "pgstack-app",
  dbPort: 15432,
  proxyPort: 3000,
  pgVersion: "16",
  schemas: ["public"],
};

/**
 * Find the project root by walking up from cwd looking for pgstack.config.json
 */
export function findProjectRoot(from?: string): string | null {
  let dir = from ?? process.cwd();
  const root = resolve(dir, "/");
  while (dir !== root) {
    if (existsSync(resolve(dir, "pgstack.config.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Load pgstack.config.json from the project root
 */
export async function loadConfig(
  projectRoot?: string
): Promise<PgStackConfig> {
  const root = projectRoot ?? findProjectRoot();
  if (!root) {
    throw new Error(
      "Not a pgStack project. Run `pgstack init <name>` first."
    );
  }

  const configPath = resolve(root, "pgstack.config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(configPath, "utf-8");
  const userConfig = JSON.parse(raw);
  return { ...DEFAULT_CONFIG, ...userConfig };
}

/**
 * Resolve DATABASE_URL from .env or environment
 */
export function getDatabaseUrl(projectRoot?: string): string {
  const envUrl = process.env.DATABASE_URL;
  if (envUrl) return envUrl;

  // Try loading .env from project root
  const root = projectRoot ?? findProjectRoot();
  if (root) {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) {
      // Lazy-load dotenv
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("dotenv").config({ path: envPath });
        if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
      } catch {
        // dotenv not available, skip
      }
    }
  }

  throw new Error(
    "DATABASE_URL is not set. Add it to your .env file or set it as an environment variable.\n" +
    "Example: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:15432/mydb"
  );
}

/**
 * Extract the database name from a DATABASE_URL.
 * e.g. "postgres://user:pass@host:5432/mydb" → "mydb"
 */
export function parseDatabaseName(databaseUrl: string): string {
  let pathname: string | undefined;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    // URL constructor may fail for some postgres:// URLs, fall back to regex
    const match = databaseUrl.match(/\/([^/?]+)(?:\?.*)?$/);
    if (match) {
      pathname = match[0];
    }
  }

  const dbName = pathname?.replace(/^\//, "");
  if (!dbName) {
    throw new Error(
      `Cannot extract database name from DATABASE_URL: ${databaseUrl}`
    );
  }
  return dbName;
}
