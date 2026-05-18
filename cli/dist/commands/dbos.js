import chalk from "chalk";
import ora from "ora";
import { findProjectRoot, getDatabaseUrl } from "../lib/config.js";
import { connectPg } from "../lib/pg.js";
export function registerDbosCommand(program) {
    const dbos = program
        .command("dbos")
        .description("DBOS job queue management commands");
    dbos
        .command("status")
        .description("Show job queue status (count by status)")
        .action(async () => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        const dbUrl = getDatabaseUrl(root);
        const spinner = ora("Fetching job queue status...").start();
        let client;
        try {
            client = await connectPg(dbUrl);
            // Check if the dbos schema and job_queue table exist
            const tableCheck = await client.query(`
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'dbos' AND table_name = 'job_queue'
          ) AS exists
        `);
            if (!tableCheck.rows[0]?.exists) {
                spinner.fail(chalk.red("DBOS job queue table not found. Run the DBOS migration first."));
                await client.end();
                process.exit(1);
            }
            // Get counts by status
            const statusResult = await client.query(`
          SELECT status, COUNT(*)::text AS count
          FROM dbos.job_queue
          GROUP BY status
          ORDER BY status
        `);
            // Get total count
            const totalResult = await client.query(`
          SELECT COUNT(*)::text AS count FROM dbos.job_queue
        `);
            // Get recent failures
            const failedResult = await client.query(`
          SELECT id::text, job_name, error, updated_at::text
          FROM dbos.job_queue
          WHERE status = 'failed'
          ORDER BY updated_at DESC
          LIMIT 5
        `);
            spinner.stop();
            const total = parseInt(totalResult.rows[0]?.count ?? "0", 10);
            console.log(chalk.bold("\nJob Queue Status\n"));
            if (total === 0) {
                console.log(chalk.dim("  No jobs in the queue.\n"));
                return;
            }
            // Display counts by status
            const statusColors = {
                pending: chalk.yellow,
                running: chalk.blue,
                completed: chalk.green,
                failed: chalk.red,
                cancelled: chalk.dim,
            };
            for (const row of statusResult.rows) {
                const colorFn = statusColors[row.status] ?? chalk.white;
                console.log(`  ${colorFn(row.status.padEnd(12))} ${chalk.bold(row.count)}`);
            }
            console.log(chalk.dim(`  ${"─".repeat(20)}`));
            console.log(`  ${"total".padEnd(12)} ${chalk.bold(String(total))}`);
            // Display recent failures
            if (failedResult.rows.length > 0) {
                console.log(chalk.bold("\nRecent Failures:\n"));
                for (const job of failedResult.rows) {
                    console.log(`  ${chalk.dim(job.id.slice(0, 8))}  ${chalk.red(job.job_name)}`);
                    if (job.error) {
                        console.log(`  ${chalk.dim("error:")} ${job.error.slice(0, 120)}`);
                    }
                    console.log(`  ${chalk.dim("at:")}    ${formatDate(job.updated_at)}`);
                    console.log();
                }
            }
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to fetch job queue status"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
        finally {
            if (client)
                await client.end();
        }
    });
    dbos
        .command("retry <id>")
        .description("Retry a failed job (reset to pending)")
        .action(async (id) => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        if (!isValidUuid(id)) {
            console.error(chalk.red("Invalid job ID. Must be a valid UUID."));
            process.exit(1);
        }
        const dbUrl = getDatabaseUrl(root);
        const spinner = ora("Retrying job...").start();
        let client;
        try {
            client = await connectPg(dbUrl);
            const result = await client.query(`
          UPDATE dbos.job_queue
          SET status = 'pending',
              attempt = 0,
              error = NULL,
              scheduled_for = now()
          WHERE id = $1::uuid AND status = 'failed'
          RETURNING id::text, job_name
        `, [id]);
            if (result.rows.length === 0) {
                spinner.fail(chalk.red("Job not found or not in 'failed' status. Only failed jobs can be retried."));
                await client.end();
                process.exit(1);
            }
            const job = result.rows[0];
            spinner.succeed(chalk.green(`Job ${chalk.cyan(job.id.slice(0, 8))} (${job.job_name}) reset to pending.`));
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to retry job"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
        finally {
            if (client)
                await client.end();
        }
    });
    dbos
        .command("cancel <id>")
        .description("Cancel a pending or running job")
        .action(async (id) => {
        const root = findProjectRoot();
        if (!root) {
            console.error(chalk.red("Not a pgStack project."));
            process.exit(1);
        }
        if (!isValidUuid(id)) {
            console.error(chalk.red("Invalid job ID. Must be a valid UUID."));
            process.exit(1);
        }
        const dbUrl = getDatabaseUrl(root);
        const spinner = ora("Cancelling job...").start();
        let client;
        try {
            client = await connectPg(dbUrl);
            const result = await client.query(`
          UPDATE dbos.job_queue
          SET status = 'cancelled',
              updated_at = now()
          WHERE id = $1::uuid AND status IN ('pending', 'running')
          RETURNING id::text, job_name
        `, [id]);
            if (result.rows.length === 0) {
                spinner.fail(chalk.red("Job not found or not in 'pending'/'running' status. Only pending or running jobs can be cancelled."));
                await client.end();
                process.exit(1);
            }
            const job = result.rows[0];
            spinner.succeed(chalk.green(`Job ${chalk.cyan(job.id.slice(0, 8))} (${job.job_name}) cancelled.`));
        }
        catch (err) {
            spinner.fail(chalk.red("Failed to cancel job"));
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
        finally {
            if (client)
                await client.end();
        }
    });
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Basic UUID v4 format validation.
 */
function isValidUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
/**
 * Format an ISO date string to a short human-readable form.
 */
function formatDate(iso) {
    try {
        return new Date(iso).toLocaleString();
    }
    catch {
        return iso;
    }
}
//# sourceMappingURL=dbos.js.map