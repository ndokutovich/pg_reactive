import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { findProjectRoot, getDatabaseUrl } from "../lib/config.js";
import { connectPg, ensureMigrationsTable, applyMigration } from "../lib/pg.js";
import { composePsqlInteractive } from "../lib/docker.js";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
export function registerDbCommand(program) {
    const db = program.command("db").description("Database management commands");
    db.command("shell")
        .description("Open a psql shell to the database")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const child = composePsqlInteractive({ cwd: root });
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
        .action(async (opts) => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const dbUrl = getDatabaseUrl(root);
        const spinner = ora("Resetting database...").start();
        let client;
        try {
            // Connect to 'postgres' db to drop/create 'app'
            const adminUrl = dbUrl.replace(/\/[^/]+$/, "/postgres");
            client = await connectPg(adminUrl);
            // Terminate existing connections
            await client.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = 'app' AND pid <> pg_backend_pid()
        `);
            await client.query("DROP DATABASE IF EXISTS app");
            await client.query("CREATE DATABASE app");
            await client.end();
            // Now connect to fresh 'app' db and run migrations
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
            spinner.succeed(chalk.green(`Database reset. Applied ${files.length} migration(s).`));
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to reset database"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
        finally {
            if (client)
                await client.end();
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
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to run seed"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
        finally {
            if (client)
                await client.end();
        }
    });
}
async function readMigrationFilesSorted(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
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
//# sourceMappingURL=db.js.map