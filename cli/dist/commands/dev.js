import chalk from "chalk";
import ora from "ora";
import { findProjectRoot, loadConfig, getDatabaseUrl, parseDatabaseName } from "../lib/config.js";
import { composeUp, composeDown, composeLogs, isDockerRunning, } from "../lib/docker.js";
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
}
//# sourceMappingURL=dev.js.map