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
  applyMigration,
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
        `-- Migration: ${safeName}\n-- Created at: ${new Date().toISOString()}\n\n`
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
          const sql = await readFile(migration.path, "utf-8");
          await applyMigration(client, migration.name, sql);
          console.log(chalk.green(`  ✓ ${migration.name}`));
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
            console.log(`  ${chalk.green("✓")} ${f.name}  ${chalk.dim(at)}`);
          } else {
            console.log(`  ${chalk.yellow("○")} ${f.name}  ${chalk.yellow("pending")}`);
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
}

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
