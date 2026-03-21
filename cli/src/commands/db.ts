import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { findProjectRoot, getDatabaseUrl, parseDatabaseName } from "../lib/config.js";
import { connectPg, ensureMigrationsTable, applyMigration } from "../lib/pg.js";
import { composePsqlInteractive } from "../lib/docker.js";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";

export function registerDbCommand(program: Command): void {
  const db = program.command("db").description("Database management commands");

  db.command("shell")
    .description("Open a psql shell to the database")
    .action(async () => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      const dbName = parseDatabaseName(dbUrl);
      const child = composePsqlInteractive({ cwd: root }, dbName);
      child.on("error", (err) => {
        console.error(chalk.red("Failed to open shell:", err.message));
        process.exit(1);
      });
      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });

  db.command("reset")
    .description("Drop and recreate the database, re-run all migrations and seed")
    .option("--no-seed", "Skip running seed.sql")
    .action(async (opts: { seed: boolean }) => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      const dbName = parseDatabaseName(dbUrl);
      const spinner = ora("Resetting database...").start();

      let client;
      try {
        // Connect to 'postgres' db to drop/create the target database
        const adminUrl = dbUrl.replace(/\/[^/]+$/, "/postgres");
        client = await connectPg(adminUrl);

        // Terminate existing connections
        await client.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()
        `, [dbName]);

        // Use double-quote identifier quoting for safety
        await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await client.query(`CREATE DATABASE "${dbName}"`);
        await client.end();

        // Now connect to the fresh database and run migrations
        spinner.text = "Running migrations...";
        client = await connectPg(dbUrl);
        await ensureMigrationsTable(client);

        const migrationsDir = resolve(root, "migrations");
        const files = await readMigrationFilesSorted(migrationsDir);

        for (const f of files) {
          spinner.text = `Applying: ${f.name}`;
          const sql = await readFile(f.path, "utf-8");
          await applyMigration(client, f.name, sql);
        }

        // Run seed if requested
        if (opts.seed) {
          const seedPath = resolve(root, "seed.sql");
          if (existsSync(seedPath)) {
            spinner.text = "Running seed...";
            const seedSql = await readFile(seedPath, "utf-8");
            if (seedSql.trim().length > 0) {
              await client.query(seedSql);
            }
          }
        }

        spinner.succeed(
          chalk.green(
            `Database reset. Applied ${files.length} migration(s).`
          )
        );
      } catch (err) {
        spinner.fail(chalk.red("Failed to reset database"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });

  db.command("seed")
    .description("Run seed.sql")
    .action(async () => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const seedPath = resolve(root, "seed.sql");
      if (!existsSync(seedPath)) {
        console.error(chalk.red("No seed.sql found."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      const spinner = ora("Running seed...").start();

      let client;
      try {
        client = await connectPg(dbUrl);
        const sql = await readFile(seedPath, "utf-8");
        await client.query(sql);
        spinner.succeed(chalk.green("Seed data applied."));
      } catch (err) {
        spinner.fail(chalk.red("Failed to run seed"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });

  // ── Database branching ────────────────────────────────────────────────
  db.command("branch")
    .description("Create a database branch (clone via TEMPLATE)")
    .argument("<name>", "Branch database name")
    .option("--delete", "Delete the branch database instead of creating it")
    .action(async (name: string, opts: { delete?: boolean }) => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const safeName = sanitizeBranchName(name);
      const dbUrl = getDatabaseUrl(root);
      const adminUrl = dbUrl.replace(/\/[^/]+$/, "/postgres");
      const currentDb = parseDatabaseName(dbUrl);

      let client;
      try {
        client = await connectPg(adminUrl);

        if (opts.delete) {
          const spinner = ora(`Deleting branch "${safeName}"...`).start();

          // Terminate connections to the branch database
          await client.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
          `, [safeName]);

          await client.query(`DROP DATABASE IF EXISTS "${safeName}"`);
          spinner.succeed(chalk.green(`Branch "${safeName}" deleted.`));
        } else {
          const spinner = ora(`Creating branch "${safeName}" from "${currentDb}"...`).start();

          // Terminate connections to template DB (PG requires no active connections to use TEMPLATE)
          await client.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
          `, [currentDb]);

          await client.query(`CREATE DATABASE "${safeName}" TEMPLATE "${currentDb}"`);
          spinner.succeed(chalk.green(`Branch "${safeName}" created from "${currentDb}".`));
          console.log(chalk.dim(`  Switch to it: pgstack db checkout ${name}`));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });

  db.command("checkout")
    .description("Switch DATABASE_URL to a branch database")
    .argument("<name>", "Branch database name to switch to")
    .action(async (name: string) => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const safeName = sanitizeBranchName(name);
      const dbUrl = getDatabaseUrl(root);
      const adminUrl = dbUrl.replace(/\/[^/]+$/, "/postgres");

      // Verify the branch database exists
      let client;
      try {
        client = await connectPg(adminUrl);
        const result = await client.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [safeName],
        );
        if (result.rows.length === 0) {
          console.error(chalk.red(`Database "${safeName}" does not exist. Create it first: pgstack db branch ${name}`));
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      } finally {
        if (client) await client.end();
      }

      // Update .env file
      const envPath = resolve(root, ".env");
      const newUrl = dbUrl.replace(/\/[^/]+$/, `/${safeName}`);

      try {
        if (existsSync(envPath)) {
          let content = await readFile(envPath, "utf-8");
          if (content.match(/^DATABASE_URL=/m)) {
            content = content.replace(
              /^DATABASE_URL=.*$/m,
              `DATABASE_URL=${newUrl}`,
            );
          } else {
            content += `\nDATABASE_URL=${newUrl}\n`;
          }
          await writeFile(envPath, content, "utf-8");
        } else {
          await writeFile(envPath, `DATABASE_URL=${newUrl}\n`, "utf-8");
        }
        console.log(chalk.green(`Switched to branch "${safeName}".`));
        console.log(chalk.dim(`  DATABASE_URL updated in .env`));
      } catch (err) {
        console.error(chalk.red("Failed to update .env"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

interface MigrationFile {
  name: string;
  path: string;
}

/**
 * Sanitize a branch name to be a valid PG identifier.
 * Allows alphanumeric, underscore, and hyphen only.
 */
export function sanitizeBranchName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitized.length === 0) {
    throw new Error("Invalid branch name: must contain alphanumeric characters, underscores, or hyphens.");
  }
  return sanitized;
}

async function readMigrationFilesSorted(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      name: basename(f, ".sql"),
      path: resolve(dir, f),
    }));
}
