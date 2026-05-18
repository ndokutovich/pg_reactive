import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import ora from "ora";

const execFileAsync = promisify(execFile);

interface DeployOptions {
  host: string;
  env: string;
  compose: string;
  dir: string;
  dryRun?: boolean;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command via execFile. Returns { stdout, stderr } on success,
 * or throws with a descriptive message on failure.
 */
async function execFileNoThrow(
  cmd: string,
  args: string[],
  timeoutMs: number = 60_000
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * Run a command on the remote host via SSH using execFile.
 * The remote command is passed as a single string argument to ssh,
 * avoiding any shell interpolation on the local side.
 */
async function sshExec(
  host: string,
  remoteCommand: string,
  timeoutMs: number = 120_000
): Promise<ExecResult> {
  return execFileNoThrow(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remoteCommand],
    timeoutMs
  );
}

/**
 * Display a formatted command that would be (or was) executed.
 */
function showCommand(label: string, cmd: string, args: string[]): void {
  const full = [cmd, ...args].join(" ");
  console.log(`  ${chalk.dim(label)}  ${chalk.cyan(full)}`);
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy pgStack to a remote Docker host via SSH")
    .requiredOption("--host <user@server>", "SSH target (e.g. deploy@10.0.0.1)")
    .option("--env <path>", "Environment file to copy", ".env.production")
    .option("--compose <path>", "Docker Compose file to use", "docker-compose.prod.yml")
    .option("--dir <path>", "Remote directory for deployment", "~/pgstack")
    .option("--dry-run", "Show what would be deployed without executing")
    .action(async (opts: DeployOptions) => {
      const host = opts.host;
      const envFile = resolve(opts.env);
      const composeFile = resolve(opts.compose);
      const remoteDir = opts.dir;
      const dryRun = opts.dryRun ?? false;

      let spinner = ora();

      // Validate inputs against shell + option injection.
      //
      // Audit round 28 F4: the previous regexes allowed leading '-' in both
      // --host and --dir. The values are spliced into argv for ssh/rsync,
      // where a leading dash turns into option-injection (e.g. host
      // "-oProxyCommand=..." or path "-e ssh-command"). The regex match
      // still allows internal dashes, but we explicitly reject any
      // path segment or the host itself starting with '-'.
      const SAFE_PATH_RE = /^[a-zA-Z0-9_.~\/-]+$/;
      const pathSegments = remoteDir.split('/').filter((s) => s.length > 0);
      if (!SAFE_PATH_RE.test(remoteDir)
          || pathSegments.includes('..')
          || pathSegments.some((s) => s.startsWith('-'))) {
        spinner.fail(chalk.red('Error: --dir path contains unsafe characters, traversal, or a leading-dash segment'));
        process.exit(1);
      }

      const SAFE_HOST_RE = /^[a-zA-Z0-9._@-]+$/;
      if (!SAFE_HOST_RE.test(host) || host.startsWith('-')) {
        spinner.fail(chalk.red('Error: --host contains unsafe characters or starts with a dash'));
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 1: Validate
      // ---------------------------------------------------------------
      const errors: string[] = [];

      if (!existsSync(envFile)) {
        errors.push(`Environment file not found: ${opts.env}`);
      }
      if (!existsSync(composeFile)) {
        errors.push(`Compose file not found: ${opts.compose}`);
      }

      if (errors.length > 0) {
        for (const msg of errors) {
          console.error(chalk.red(`Error: ${msg}`));
        }
        console.log();
        console.log(chalk.dim("Hint: Run `pgstack init <name>` to create a project, then"));
        console.log(chalk.dim("create .env.production and docker-compose.prod.yml for deployment."));
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 2: Show plan
      // ---------------------------------------------------------------
      console.log();
      console.log(chalk.bold("Deploy Plan"));
      console.log();
      console.log(`  ${chalk.dim("Host:")}         ${chalk.cyan(host)}`);
      console.log(`  ${chalk.dim("Remote dir:")}   ${chalk.cyan(remoteDir)}`);
      console.log(`  ${chalk.dim("Compose:")}      ${chalk.cyan(opts.compose)}`);
      console.log(`  ${chalk.dim("Env:")}          ${chalk.cyan(opts.env)}`);

      // Detect optional directories
      const publicDir = resolve("public");
      const migrationsDir = resolve("migrations");
      const hasPublic = existsSync(publicDir);
      const hasMigrations = existsSync(migrationsDir);

      if (hasPublic) {
        console.log(`  ${chalk.dim("Public:")}       ${chalk.cyan("public/")}`);
      }
      if (hasMigrations) {
        console.log(`  ${chalk.dim("Migrations:")}   ${chalk.cyan("migrations/")}`);
      }

      console.log();

      if (dryRun) {
        console.log(chalk.yellow("Dry run -- showing commands that would be executed:\n"));
        showDryRun(host, remoteDir, composeFile, envFile, hasPublic, hasMigrations);
        return;
      }

      // ---------------------------------------------------------------
      // Step 3: Ensure remote directory exists
      // ---------------------------------------------------------------
      spinner = ora("Connecting to remote host...").start();

      try {
        await sshExec(host, `mkdir -p ${remoteDir}`);
        spinner.succeed("Connected to remote host");
      } catch (err) {
        spinner.fail(chalk.red("Failed to connect to remote host"));
        console.error();
        console.error(
          chalk.dim(
            err instanceof Error ? err.message : String(err)
          )
        );
        console.error();
        console.error(chalk.dim("Suggestions:"));
        console.error(chalk.dim("  - Check that SSH key authentication is configured"));
        console.error(chalk.dim("  - Verify the host is reachable: ssh " + host));
        console.error(chalk.dim("  - Ensure the remote user has permissions to create directories"));
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 4: Sync files via rsync
      // ---------------------------------------------------------------
      const syncSpinner = ora("Syncing files to remote...").start();

      try {
        // Build the rsync source list. We use individual rsync calls for
        // files that need renaming (compose -> docker-compose.yml, env -> .env).
        // Then rsync directories that keep their names.

        // Sync compose file as docker-compose.yml
        await execFileNoThrow("rsync", [
          "-avz",
          "--chmod=F644",
          composeFile,
          `${host}:${remoteDir}/docker-compose.yml`,
        ]);

        // Sync env file as .env
        await execFileNoThrow("rsync", [
          "-avz",
          "--chmod=F600",
          envFile,
          `${host}:${remoteDir}/.env`,
        ]);

        // Sync public/ directory if it exists
        if (hasPublic) {
          await execFileNoThrow("rsync", [
            "-avz",
            "--delete",
            publicDir + "/",
            `${host}:${remoteDir}/public/`,
          ]);
        }

        // Sync migrations/ directory if it exists
        if (hasMigrations) {
          await execFileNoThrow("rsync", [
            "-avz",
            "--delete",
            migrationsDir + "/",
            `${host}:${remoteDir}/migrations/`,
          ]);
        }

        syncSpinner.succeed("Files synced to remote");
      } catch (err) {
        syncSpinner.fail(chalk.red("Failed to sync files"));
        console.error();
        console.error(
          chalk.dim(err instanceof Error ? err.message : String(err))
        );
        console.error();
        console.error(chalk.dim("Hint: Ensure rsync is installed on both local and remote machines."));
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 5: Pull images and restart services
      // ---------------------------------------------------------------
      const pullSpinner = ora("Pulling images and restarting services...").start();

      try {
        await sshExec(
          host,
          `cd ${remoteDir} && docker compose pull && docker compose up -d`,
          300_000 // 5 minutes for image pull
        );
        pullSpinner.succeed("Services updated and running");
      } catch (err) {
        pullSpinner.fail(chalk.red("Failed to pull/restart services"));
        console.error();
        console.error(
          chalk.dim(err instanceof Error ? err.message : String(err))
        );
        console.error();
        console.error(chalk.dim("Hint: Ensure Docker and Docker Compose are installed on the remote host."));
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 6: Run migrations
      // ---------------------------------------------------------------
      if (hasMigrations) {
        const migrateSpinner = ora("Running migrations...").start();

        try {
          const result = await sshExec(
            host,
            `cd ${remoteDir} && docker compose exec -T proxy pgstack-proxy migrate`,
            120_000
          );
          const output = (result.stdout + result.stderr).trim();
          if (output) {
            migrateSpinner.succeed("Migrations applied");
            console.log(chalk.dim(`  ${output.split("\n").join("\n  ")}`));
          } else {
            migrateSpinner.succeed("Migrations applied (no output)");
          }
        } catch (err) {
          migrateSpinner.warn(chalk.yellow("Migration step failed (non-fatal)"));
          console.log(
            chalk.dim(
              "  This may be expected if the proxy does not have a `migrate` subcommand."
            )
          );
          console.log(
            chalk.dim(
              "  You can run migrations manually: ssh " +
                host +
                " 'cd " +
                remoteDir +
                " && docker compose exec -T db psql -U postgres -f /migrations/...'"
            )
          );
        }
      }

      // ---------------------------------------------------------------
      // Step 7: Health check
      // ---------------------------------------------------------------
      const healthSpinner = ora("Running health check...").start();

      let healthy = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await sshExec(
            host,
            "curl -sf http://127.0.0.1:8080/health",
            15_000
          );
          const body = result.stdout.trim();
          healthSpinner.succeed(`Health check passed${body ? ": " + chalk.dim(body) : ""}`);
          healthy = true;
          break;
        } catch {
          if (attempt < 3) {
            healthSpinner.text = `Health check attempt ${attempt}/3 failed, retrying in 5s...`;
            await sleep(5000);
          }
        }
      }

      if (!healthy) {
        healthSpinner.warn(
          chalk.yellow("Health check failed after 3 attempts")
        );
        console.log(
          chalk.dim(
            "  The service may still be starting. Check logs with:"
          )
        );
        console.log(
          chalk.dim(`  ssh ${host} 'cd ${remoteDir} && docker compose logs --tail=50'`)
        );
      }

      // ---------------------------------------------------------------
      // Step 8: Summary
      // ---------------------------------------------------------------
      console.log();
      if (healthy) {
        console.log(chalk.green.bold("Deploy complete."));
      } else {
        console.log(chalk.yellow.bold("Deploy finished with warnings."));
      }
      console.log();
      console.log(chalk.dim("Useful commands:"));
      console.log(chalk.dim(`  ssh ${host} 'cd ${remoteDir} && docker compose logs -f'`));
      console.log(chalk.dim(`  ssh ${host} 'cd ${remoteDir} && docker compose ps'`));
      console.log();
    });
}

/**
 * Display all commands that would be executed during a dry run.
 */
function showDryRun(
  host: string,
  remoteDir: string,
  composeFile: string,
  envFile: string,
  hasPublic: boolean,
  hasMigrations: boolean
): void {
  console.log(chalk.bold("1. Ensure remote directory"));
  showCommand("ssh", "ssh", [host, `mkdir -p ${remoteDir}`]);
  console.log();

  console.log(chalk.bold("2. Sync files"));
  showCommand("rsync", "rsync", [
    "-avz", "--chmod=F644",
    composeFile,
    `${host}:${remoteDir}/docker-compose.yml`,
  ]);
  showCommand("rsync", "rsync", [
    "-avz", "--chmod=F600",
    envFile,
    `${host}:${remoteDir}/.env`,
  ]);
  if (hasPublic) {
    showCommand("rsync", "rsync", [
      "-avz", "--delete",
      "public/",
      `${host}:${remoteDir}/public/`,
    ]);
  }
  if (hasMigrations) {
    showCommand("rsync", "rsync", [
      "-avz", "--delete",
      "migrations/",
      `${host}:${remoteDir}/migrations/`,
    ]);
  }
  console.log();

  console.log(chalk.bold("3. Pull and restart"));
  showCommand("ssh", "ssh", [
    host,
    `cd ${remoteDir} && docker compose pull && docker compose up -d`,
  ]);
  console.log();

  if (hasMigrations) {
    console.log(chalk.bold("4. Run migrations"));
    showCommand("ssh", "ssh", [
      host,
      `cd ${remoteDir} && docker compose exec -T proxy pgstack-proxy migrate`,
    ]);
    console.log();
  }

  console.log(chalk.bold(hasMigrations ? "5. Health check" : "4. Health check"));
  showCommand("ssh", "ssh", [
    host,
    "curl -sf http://127.0.0.1:8080/health",
  ]);
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
