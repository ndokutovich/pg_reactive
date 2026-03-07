import { Command } from "commander";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { watch, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import chalk from "chalk";
import ora from "ora";

const FUNCTIONS_DIR = "supabase/functions";

const FUNCTION_TEMPLATE = `// Edge function: {name}
// Docs: https://pgstack.dev/docs/edge-functions

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));

  return new Response(
    JSON.stringify({ message: "Hello from {name}!" }),
    { headers: { "Content-Type": "application/json" } },
  );
});
`;

export function registerFunctionsCommand(program: Command): void {
  const cmd = program
    .command("functions")
    .description("Manage edge functions");

  cmd
    .command("new <name>")
    .description("Scaffold a new edge function")
    .action(async (name: string) => {
      const fnDir = resolve(FUNCTIONS_DIR, name);

      if (existsSync(fnDir)) {
        console.error(chalk.red(`Function "${name}" already exists at ${fnDir}`));
        process.exit(1);
      }

      await mkdir(fnDir, { recursive: true });
      await writeFile(
        join(fnDir, "index.ts"),
        FUNCTION_TEMPLATE.replace(/\{name\}/g, name),
      );

      console.log(chalk.green(`Created ${fnDir}/index.ts`));
      console.log(chalk.dim("Deploy with: pgstack functions deploy " + name));
    });

  cmd
    .command("list")
    .description("List all edge functions")
    .option("--url <url>", "pgStack proxy URL", "http://127.0.0.1:8080")
    .option("--service-role-key <key>", "Service role key")
    .action(async (opts: { url: string; serviceRoleKey?: string }) => {
      const key = opts.serviceRoleKey || process.env.SERVICE_ROLE_KEY;
      if (!key) {
        console.error(chalk.red("--service-role-key or SERVICE_ROLE_KEY env required"));
        process.exit(1);
      }

      const spinner = ora("Fetching functions...").start();
      try {
        const res = await fetch(`${opts.url}/functions/v1/`, {
          headers: {
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          spinner.fail(chalk.red(`Error: ${(body as Record<string, string>).error || res.statusText}`));
          process.exit(1);
        }

        const fns = await res.json() as Array<{
          name: string;
          runtime: string;
          status: string;
          verify_jwt: boolean;
        }>;
        spinner.stop();

        if (fns.length === 0) {
          console.log(chalk.dim("No edge functions registered."));
          return;
        }

        console.log(chalk.bold("Edge Functions:\n"));
        for (const fn of fns) {
          const jwt = fn.verify_jwt ? chalk.green("JWT") : chalk.dim("open");
          console.log(`  ${chalk.cyan(fn.name)}  ${chalk.dim(fn.runtime)}  ${jwt}  ${fn.status}`);
        }
      } catch (e) {
        spinner.fail(chalk.red(`Connection failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("deploy <name>")
    .description("Register an edge function in the database")
    .option("--url <url>", "pgStack proxy URL", "http://127.0.0.1:8080")
    .option("--service-role-key <key>", "Service role key")
    .option("--runtime <runtime>", "Runtime: deno, embedded, plv8", "deno")
    .option("--no-verify-jwt", "Allow anonymous invocation")
    .action(async (name: string, opts: {
      url: string;
      serviceRoleKey?: string;
      runtime: string;
      verifyJwt: boolean;
    }) => {
      const key = opts.serviceRoleKey || process.env.SERVICE_ROLE_KEY;
      if (!key) {
        console.error(chalk.red("--service-role-key or SERVICE_ROLE_KEY env required"));
        process.exit(1);
      }

      let code: string | null = null;
      if (opts.runtime === "embedded" || opts.runtime === "plv8") {
        const fnFile = resolve(FUNCTIONS_DIR, name, "index.ts");
        if (!existsSync(fnFile)) {
          console.error(chalk.red(`Function source not found: ${fnFile}`));
          process.exit(1);
        }
        code = await readFile(fnFile, "utf-8");
      }

      const spinner = ora(`Deploying ${name}...`).start();
      try {
        // Upsert function via SQL endpoint (service_role)
        const sql = `
          INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, status, code, updated_at)
          VALUES ($1, $2, $3, 'active', $4, now())
          ON CONFLICT (name) DO UPDATE SET
            runtime = EXCLUDED.runtime,
            verify_jwt = EXCLUDED.verify_jwt,
            code = EXCLUDED.code,
            status = 'active',
            updated_at = now()
        `;

        const sqlRes = await fetch(`${opts.url}/api/sql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
          body: JSON.stringify({
            query: sql,
            params: [name, opts.runtime, opts.verifyJwt, code],
          }),
        });

        if (!sqlRes.ok) {
          const body = await sqlRes.json().catch(() => ({}));
          spinner.fail(chalk.red(`Deploy failed: ${(body as Record<string, string>).error || sqlRes.statusText}`));
          process.exit(1);
        }

        // Refresh the functions catalog
        await fetch(`${opts.url}/functions/v1/_refresh`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
        });

        spinner.succeed(chalk.green(`Deployed ${name} (${opts.runtime})`));
      } catch (e) {
        spinner.fail(chalk.red(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("delete <name>")
    .description("Deactivate an edge function")
    .option("--url <url>", "pgStack proxy URL", "http://127.0.0.1:8080")
    .option("--service-role-key <key>", "Service role key")
    .action(async (name: string, opts: { url: string; serviceRoleKey?: string }) => {
      const key = opts.serviceRoleKey || process.env.SERVICE_ROLE_KEY;
      if (!key) {
        console.error(chalk.red("--service-role-key or SERVICE_ROLE_KEY env required"));
        process.exit(1);
      }

      const spinner = ora(`Deleting ${name}...`).start();
      try {
        const sql = `UPDATE pgstack.edge_functions SET status = 'inactive', updated_at = now() WHERE name = $1`;
        const sqlRes = await fetch(`${opts.url}/api/sql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
          body: JSON.stringify({ query: sql, params: [name] }),
        });

        if (!sqlRes.ok) {
          const body = await sqlRes.json().catch(() => ({}));
          spinner.fail(chalk.red(`Delete failed: ${(body as Record<string, string>).error || sqlRes.statusText}`));
          process.exit(1);
        }

        // Refresh catalog
        await fetch(`${opts.url}/functions/v1/_refresh`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "apikey": key,
          },
        });

        spinner.succeed(chalk.green(`Deactivated ${name}`));
      } catch (e) {
        spinner.fail(chalk.red(`Delete failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("serve")
    .description("Watch supabase/functions/ and hot-reload on file changes")
    .option("--url <url>", "pgStack proxy URL", "http://127.0.0.1:8080")
    .option("--service-role-key <key>", "Service role key")
    .option("--runtime <runtime>", "Runtime for watched functions", "embedded")
    .action(async (opts: { url: string; serviceRoleKey?: string; runtime: string }) => {
      const key = opts.serviceRoleKey || process.env.SERVICE_ROLE_KEY;
      if (!key) {
        console.error(chalk.red("--service-role-key or SERVICE_ROLE_KEY env required"));
        process.exit(1);
      }

      const fnDir = resolve(FUNCTIONS_DIR);
      if (!existsSync(fnDir)) {
        console.error(chalk.red(`Functions directory not found: ${fnDir}`));
        console.error(chalk.dim("Run: pgstack functions new <name>"));
        process.exit(1);
      }

      console.log(chalk.cyan(`Watching ${fnDir} for changes...`));
      console.log(chalk.dim("Press Ctrl+C to stop.\n"));

      // Deploy a single function by name.
      async function deploy(name: string): Promise<void> {
        const fnFile = join(fnDir, name, "index.ts");
        if (!existsSync(fnFile)) return;

        let code: string | null = null;
        if (opts.runtime === "embedded" || opts.runtime === "plv8" || opts.runtime === "plpython3u") {
          code = await readFile(fnFile, "utf-8");
        }

        const sql = `
          INSERT INTO pgstack.edge_functions (name, runtime, verify_jwt, status, code, updated_at)
          VALUES ($1, $2, true, 'active', $3, now())
          ON CONFLICT (name) DO UPDATE SET
            runtime = EXCLUDED.runtime,
            code = EXCLUDED.code,
            status = 'active',
            updated_at = now()
        `;

        const res = await fetch(`${opts.url}/api/sql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
            "apikey": key!,
          },
          body: JSON.stringify({ query: sql, params: [name, opts.runtime, code] }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error(chalk.red(`  ✗ ${name}: ${(body as Record<string, string>).error || res.statusText}`));
          return;
        }

        // Trigger catalog refresh (NOTIFY also fires via DB trigger, but be explicit).
        await fetch(`${opts.url}/functions/v1/_refresh`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${key}`, "apikey": key! },
        }).catch(() => { /* non-fatal: DB NOTIFY will refresh the catalog anyway */ });

        console.log(chalk.green(`  ↻ ${name}`), chalk.dim(`[${new Date().toLocaleTimeString()}]`));
      }

      // Initial deploy of all existing functions.
      const entries = await stat(fnDir).then(() => {
        return readdirSync(fnDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
      }).catch(() => [] as string[]);

      for (const name of entries) {
        await deploy(name).catch(e => console.error(chalk.red(`  ✗ ${name}: ${e}`)));
      }

      // Watch for changes with debounce.
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      watch(fnDir, { recursive: true }, (_event, filename) => {
        if (!filename?.endsWith(".ts") && !filename?.endsWith(".js") && !filename?.endsWith(".py")) return;
        // Derive function name from first directory segment of the changed path.
        const fnName = filename.split(/[\\/]/)[0];
        if (!fnName) return;

        if (pending.has(fnName)) clearTimeout(pending.get(fnName)!);
        pending.set(fnName, setTimeout(() => {
          pending.delete(fnName);
          deploy(fnName).catch(e => console.error(chalk.red(`  ✗ ${fnName}: ${e}`)));
        }, 200));
      });

      // Keep running until Ctrl+C.
      await new Promise(() => {});
    });
}
