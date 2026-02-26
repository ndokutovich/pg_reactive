import chalk from "chalk";
import ora from "ora";
import { execFile } from "node:child_process";
import { findProjectRoot, loadConfig, getDatabaseUrl, parseDatabaseName, } from "../lib/config.js";
import { composeUp, composeDown, composeLogs, isDockerRunning, composePsJson, } from "../lib/docker.js";
import { connectPg, ensureMigrationsTable, getAppliedMigrations, getSubscriptionCount, } from "../lib/pg.js";
export function registerDevCommand(program) {
    program
        .command("dev")
        .description("Start pgStack (PostgreSQL + proxy)")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project. Run `pgstack init <name>` first."));
            process.exit(1);
        }
        if (!(await isDockerRunning())) {
            console.error(chalk.red("Docker is not running. Please start Docker first."));
            process.exit(1);
        }
        const config = await loadConfig(root);
        const dbUrl = getDatabaseUrl(root);
        const dbName = parseDatabaseName(dbUrl);
        const spinner = ora("Starting pgStack...").start();
        try {
            await composeUp({ cwd: root });
            spinner.succeed(chalk.green("pgStack is running!"));
            console.log();
            console.log(`  PostgreSQL:  ${chalk.cyan(`postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/${dbName}`)}`);
            console.log(`  REST API:    ${chalk.cyan(`http://127.0.0.1:${config.proxyPort}/rest/v1/`)}`);
            console.log(`  WebSocket:   ${chalk.cyan(`ws://127.0.0.1:${config.proxyPort}/ws/`)}`);
            console.log(`  Health:      ${chalk.cyan(`http://127.0.0.1:${config.proxyPort}/health`)}`);
            console.log();
            console.log(chalk.dim("Run `pgstack logs` to see output, `pgstack stop` to shut down."));
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to start pgStack"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    });
    program
        .command("stop")
        .description("Stop pgStack")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const spinner = ora("Stopping pgStack...").start();
        try {
            await composeDown({ cwd: root });
            spinner.succeed(chalk.green("pgStack stopped."));
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to stop pgStack"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    });
    program
        .command("logs")
        .description("Show pgStack logs")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const child = composeLogs({ cwd: root });
        child.on("error", (err) => {
            console.error(chalk.red("Failed to show logs:", err.message));
            process.exit(1);
        });
    });
    program
        .command("status")
        .description("Show status of running pgStack services")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const config = await loadConfig(root);
        console.log(chalk.bold("\npgStack Status\n"));
        // --- 1. Docker containers ---
        console.log(chalk.underline("Containers:"));
        const containers = await composePsJson({ cwd: root });
        if (containers.length === 0) {
            console.log(chalk.dim("  No containers running. Run `pgstack dev` to start."));
        }
        else {
            for (const c of containers) {
                const health = c.Health ? ` (${c.Health})` : "";
                const state = c.State ?? c.Status ?? "unknown";
                const stateLabel = state === "running"
                    ? chalk.green(state + health)
                    : chalk.yellow(state + health);
                console.log(`  ${chalk.cyan(c.Service ?? c.Name)}  ${stateLabel}`);
            }
        }
        console.log();
        // --- 2. Proxy health ---
        console.log(chalk.underline("Proxy health:"));
        const proxyUrl = `http://127.0.0.1:${config.proxyPort}/health`;
        try {
            const healthResponse = await fetchWithTimeout(proxyUrl, 3000);
            const body = await healthResponse.text();
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                parsed = body;
            }
            if (healthResponse.ok) {
                const version = typeof parsed === "object" &&
                    parsed !== null &&
                    "version" in parsed
                    ? String(parsed.version)
                    : null;
                const versionLabel = version ? chalk.dim(` v${version}`) : "";
                console.log(`  ${chalk.green("healthy")}${versionLabel}  ${chalk.dim(proxyUrl)}`);
            }
            else {
                console.log(`  ${chalk.yellow(`HTTP ${healthResponse.status}`)}  ${chalk.dim(proxyUrl)}`);
            }
        }
        catch {
            console.log(`  ${chalk.red("unreachable")}  ${chalk.dim(proxyUrl)}`);
        }
        console.log();
        // --- 3. Migration status ---
        console.log(chalk.underline("Migrations:"));
        let dbUrl;
        try {
            dbUrl = getDatabaseUrl(root);
        }
        catch {
            console.log(chalk.dim("  DATABASE_URL not configured — skipping migration check."));
            console.log();
            return;
        }
        let client;
        try {
            client = await connectPgWithTimeout(dbUrl, 3000);
            await ensureMigrationsTable(client);
            const { resolve } = await import("node:path");
            const { readdir } = await import("node:fs/promises");
            const migrationsDir = resolve(root, "migrations");
            let allFiles = [];
            try {
                allFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql"));
            }
            catch {
                // no migrations directory
            }
            const applied = await getAppliedMigrations(client);
            const appliedNames = new Set(applied.map((m) => m.name));
            const pending = allFiles
                .map((f) => f.replace(/\.sql$/, ""))
                .filter((name) => !appliedNames.has(name));
            if (pending.length === 0) {
                console.log(`  ${chalk.green("All migrations applied")}  (${applied.length} total)`);
            }
            else {
                console.log(`  ${chalk.yellow(`${pending.length} unpushed migration${pending.length > 1 ? "s" : ""}`)}`);
                for (const name of pending) {
                    console.log(`    ${chalk.yellow("o")} ${name}`);
                }
            }
            // --- 4. Active subscriptions ---
            console.log();
            console.log(chalk.underline("Live subscriptions:"));
            const subCount = await getSubscriptionCount(client);
            if (subCount === null) {
                console.log(chalk.dim("  pg_reactive extension not loaded."));
            }
            else {
                console.log(`  ${chalk.cyan(String(subCount))} active subscription${subCount !== 1 ? "s" : ""}`);
            }
        }
        catch (err) {
            console.log(`  ${chalk.red("Cannot connect to database")}  ${chalk.dim(err instanceof Error ? err.message : String(err))}`);
        }
        finally {
            if (client) {
                try {
                    await client.end();
                }
                catch {
                    // ignore cleanup errors
                }
            }
        }
        console.log();
    });
    program
        .command("studio")
        .description("Open pgStack Studio in the browser")
        .option("--url <url>", "Proxy base URL", "http://127.0.0.1:8080")
        .action(async (opts) => {
        const studioUrl = `${opts.url}/studio/`;
        console.log(`Opening pgStack Studio: ${studioUrl}`);
        openInBrowser(studioUrl);
    });
}
/**
 * Open a URL in the default browser using a platform-appropriate launcher.
 * Uses execFile to avoid shell injection: the URL is passed as a direct argument.
 */
function openInBrowser(url) {
    let cmd;
    let args;
    if (process.platform === "win32") {
        // On Windows, `cmd /c start` handles URLs directly.
        cmd = "cmd";
        args = ["/c", "start", "", url];
    }
    else if (process.platform === "darwin") {
        cmd = "open";
        args = [url];
    }
    else {
        cmd = "xdg-open";
        args = [url];
    }
    execFile(cmd, args, (err) => {
        if (err) {
            console.error(chalk.red(`Failed to open browser: ${err.message}`));
            console.log(chalk.dim(`Visit manually: ${url}`));
        }
    });
}
/**
 * Perform a fetch with a timeout (ms). Throws on timeout or network error.
 */
async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Connect to PostgreSQL with a connection timeout.
 */
async function connectPgWithTimeout(dbUrl, timeoutMs) {
    return Promise.race([
        connectPg(dbUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
}
//# sourceMappingURL=dev.js.map