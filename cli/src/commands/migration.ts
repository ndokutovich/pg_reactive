import { Command } from "commander";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { findProjectRoot } from "../lib/config.js";
import { getDatabaseUrl } from "../lib/config.js";
import {
  connectPg,
  ensureMigrationsTable,
  getAppliedMigrations,
  getLastAppliedMigrations,
  applyMigration,
  rollbackMigration,
} from "../lib/pg.js";

export function registerMigrationCommand(program: Command): void {
  const migration = program
    .command("migration")
    .description("Manage database migrations");

  migration
    .command("create <name>")
    .description("Create a new migration file")
    .action(async (name: string) => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const timestamp = generateTimestamp();
      const safeName = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
      const filename = `${timestamp}_${safeName}.sql`;
      const migrationsDir = resolve(root, "migrations");
      const filePath = resolve(migrationsDir, filename);

      await writeFile(
        filePath,
        `-- Migration: ${safeName}\n-- Created at: ${new Date().toISOString()}\n\n-- migrate:up\n\n\n-- migrate:down\n`
      );

      console.log(chalk.green(`Created migration: ${chalk.cyan(filename)}`));
      console.log(chalk.dim(`  ${filePath}`));
    });

  migration
    .command("run")
    .description("Apply pending migrations")
    .action(async () => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      const spinner = ora("Connecting to database...").start();

      let client;
      try {
        client = await connectPg(dbUrl);
        spinner.text = "Checking migrations...";

        await ensureMigrationsTable(client);
        const applied = await getAppliedMigrations(client);
        const appliedNames = new Set(applied.map((m) => m.name));

        // Read migration files
        const migrationsDir = resolve(root, "migrations");
        const files = await readMigrationFiles(migrationsDir);
        const pending = files.filter((f) => !appliedNames.has(f.name));

        if (pending.length === 0) {
          spinner.succeed(chalk.green("All migrations are up to date."));
          return;
        }

        spinner.text = `Applying ${pending.length} migration(s)...`;

        for (const migration of pending) {
          spinner.text = `Applying: ${migration.name}`;
          const raw = await readFile(migration.path, "utf-8");
          // Extract the "-- migrate:up" section if present; otherwise use full file.
          const sql = extractUpSection(raw);
          await applyMigration(client, migration.name, sql);
          console.log(chalk.green(`  ${chalk.green("+")} ${migration.name}`));
        }

        spinner.succeed(
          chalk.green(`Applied ${pending.length} migration(s).`)
        );
      } catch (err) {
        spinner.fail(chalk.red("Migration failed"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });

  migration
    .command("status")
    .description("Show migration status")
    .action(async () => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      let client;
      try {
        client = await connectPg(dbUrl);
        await ensureMigrationsTable(client);
        const applied = await getAppliedMigrations(client);
        const appliedNames = new Set(applied.map((m) => m.name));
        const appliedMap = new Map(applied.map((m) => [m.name, m.applied_at]));

        const migrationsDir = resolve(root, "migrations");
        const files = await readMigrationFiles(migrationsDir);

        if (files.length === 0) {
          console.log(chalk.dim("No migration files found."));
          return;
        }

        console.log(chalk.bold("\nMigration Status:\n"));
        for (const f of files) {
          if (appliedNames.has(f.name)) {
            const at = appliedMap.get(f.name) ?? "";
            const dateLabel = at
              ? chalk.dim(`  applied ${formatDate(at)}`)
              : "";
            console.log(
              `  ${chalk.green("v")} ${chalk.green(f.name)}${dateLabel}`
            );
          } else {
            console.log(
              `  ${chalk.dim("o")} ${chalk.dim(f.name)}  ${chalk.yellow("pending")}`
            );
          }
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Failed to check status"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });

  migration
    .command("rollback")
    .description("Roll back the last migration(s)")
    .option("-n, --count <n>", "Number of migrations to roll back", "1")
    .option("--dry-run", "Show SQL without executing")
    .action(async (opts: { count: string; dryRun?: boolean }) => {
      const root = findProjectRoot();
      if (!root) {
        console.error(chalk.red("Not a pgStack project."));
        process.exit(1);
      }

      const count = parseInt(opts.count, 10);
      if (isNaN(count) || count < 1) {
        console.error(chalk.red("--count must be a positive integer."));
        process.exit(1);
      }

      const dbUrl = getDatabaseUrl(root);
      const spinner = ora("Connecting to database...").start();

      let client;
      try {
        client = await connectPg(dbUrl);
        spinner.text = "Reading applied migrations...";

        await ensureMigrationsTable(client);
        const toRollback = await getLastAppliedMigrations(client, count);

        if (toRollback.length === 0) {
          spinner.succeed(chalk.green("No applied migrations to roll back."));
          return;
        }

        spinner.stop();

        const migrationsDir = resolve(root, "migrations");

        if (opts.dryRun) {
          console.log(chalk.bold("\nDry run — SQL that would be executed:\n"));
        }

        for (const record of toRollback) {
          const filePath = resolve(migrationsDir, `${record.name}.sql`);
          let fileContent: string;
          try {
            fileContent = await readFile(filePath, "utf-8");
          } catch {
            console.warn(
              chalk.yellow(
                `  Warning: migration file not found for "${record.name}" — skipping.`
              )
            );
            continue;
          }

          const downSql = extractDownSection(fileContent);
          if (!downSql.trim()) {
            console.warn(
              chalk.yellow(
                `  Warning: no "-- migrate:down" section in "${record.name}" — skipping.`
              )
            );
            continue;
          }

          if (opts.dryRun) {
            console.log(chalk.bold(`-- ${record.name}`));
            console.log(chalk.dim(downSql));
            console.log();
          } else {
            process.stdout.write(
              `  Rolling back: ${chalk.cyan(record.name)} ... `
            );
            await rollbackMigration(client, record.name, downSql);
            console.log(chalk.green("done"));
          }
        }

        if (!opts.dryRun) {
          console.log(
            chalk.green(
              `\nRolled back ${toRollback.length} migration${toRollback.length > 1 ? "s" : ""}.`
            )
          );
        }
      } catch (err) {
        spinner.fail(chalk.red("Rollback failed"));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        if (client) await client.end();
      }
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MigrationFile {
  name: string;
  path: string;
}

async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
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

/**
 * Extract SQL after "-- migrate:up" and before "-- migrate:down".
 * If no section markers are present, returns the full content.
 */
function extractUpSection(content: string): string {
  const upIdx = content.indexOf("-- migrate:up");
  const downIdx = content.indexOf("-- migrate:down");

  if (upIdx === -1) {
    // No markers — treat entire file as up SQL (legacy format).
    if (downIdx === -1) return content;
    return content.slice(0, downIdx);
  }

  const afterUp = content.slice(upIdx + "-- migrate:up".length);
  const downRelIdx = afterUp.indexOf("-- migrate:down");
  if (downRelIdx === -1) return afterUp;
  return afterUp.slice(0, downRelIdx);
}

/**
 * Extract SQL after "-- migrate:down".
 * Returns an empty string if no down section is present.
 */
function extractDownSection(content: string): string {
  const downIdx = content.indexOf("-- migrate:down");
  if (downIdx === -1) return "";
  return content.slice(downIdx + "-- migrate:down".length);
}

/**
 * Format an ISO date string to a short human-readable form.
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function generateTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
