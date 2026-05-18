#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { registerInitCommand } from "./commands/init.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerMigrationCommand } from "./commands/migration.js";
import { registerDbCommand } from "./commands/db.js";
import { registerGenerateCommand } from "./commands/generate.js";
import { registerDbosCommand } from "./commands/dbos.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerFunctionsCommand } from "./commands/functions.js";
// Resolve version from package.json at runtime so the binary always reports
// the correct version without requiring a manual sync in source code.
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const program = new Command();
program
    .name("pgstack")
    .description("Postgres-native backend platform. One PostgreSQL. Zero extra containers.")
    .version(version, "-v, --version", "Print pgstack CLI version and exit")
    .option("--verbose", "Enable verbose diagnostic output")
    .option("--url <url>", "pgStack proxy URL (overrides PGSTACK_URL env var)")
    .option("--json", "Output results as JSON (machine-readable)");
// Propagate global flags into environment variables so all subcommands can
// read them without needing to traverse the parent command tree.
program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose)
        process.env["PGSTACK_VERBOSE"] = "1";
    if (opts.url)
        process.env["PGSTACK_URL"] = opts.url;
    if (opts.json)
        process.env["PGSTACK_JSON"] = "1";
});
registerInitCommand(program);
registerDevCommand(program);
registerMigrationCommand(program);
registerDbCommand(program);
registerGenerateCommand(program);
registerDbosCommand(program);
registerDeployCommand(program);
registerFunctionsCommand(program);
// Graceful error handling — unhandled rejections from async command handlers
// print a clean message instead of a raw stack trace, unless --verbose is set.
process.on("unhandledRejection", (reason) => {
    if (process.env["PGSTACK_VERBOSE"]) {
        console.error(reason);
    }
    else {
        const msg = reason instanceof Error ? reason.message : String(reason);
        console.error(`\nError: ${msg}`);
        console.error("Run with --verbose for the full stack trace.");
    }
    process.exit(1);
});
// Clean exit on Ctrl+C without printing "^C" on some terminals.
process.on("SIGINT", () => {
    process.exit(0);
});
program.parse();
//# sourceMappingURL=index.js.map