import type { PgStackJobQueue } from './queue.js';

/**
 * Simple cron-style scheduler backed by pgStack job queue.
 * Jobs are deduplicated — if a cron job is already queued/running, it won't be re-enqueued.
 */
export class PgStackScheduler {
  private jobs: Map<string, {
    cron: string;
    handler: () => Promise<void>;
    intervalId: ReturnType<typeof setInterval>;
  }> = new Map();

  private queue: PgStackJobQueue;

  constructor(queue: PgStackJobQueue) {
    this.queue = queue;
  }

  /**
   * Schedule a job by cron expression.
   * Supported: simple interval expressions like "*\/5 * * * *" (every 5 min).
   * For full cron support, install the `croner` package (optional peer dep).
   */
  schedule(name: string, cronExpr: string, handler: () => Promise<void>): this {
    // Register handler with the queue
    this.queue.register(`cron:${name}`, handler);

    // Parse simple interval: "*\/N * * * *" (minutes only for now)
    const intervalMs = parseCronToMs(cronExpr);
    if (intervalMs === null) {
      console.warn(
        `[pgstack-scheduler] Unsupported cron "${cronExpr}" for job "${name}" — use */N * * * * (minute-interval) format`,
      );
      return this;
    }

    const intervalId = setInterval(async () => {
      try {
        await this.queue.enqueue(`cron:${name}`, { cron: cronExpr, name });
      } catch (e) {
        console.error(`[pgstack-scheduler] Failed to enqueue cron job ${name}:`, e);
      }
    }, intervalMs);

    this.jobs.set(name, { cron: cronExpr, handler, intervalId });
    return this;
  }

  /** Stop all scheduled jobs */
  stop(): void {
    for (const { intervalId } of this.jobs.values()) {
      clearInterval(intervalId);
    }
    this.jobs.clear();
  }

  listScheduled(): Array<{ name: string; cron: string }> {
    return Array.from(this.jobs.entries()).map(([name, { cron }]) => ({ name, cron }));
  }
}

/** Parse "*\/N * * * *" to milliseconds. Returns null for unsupported patterns. */
function parseCronToMs(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutePart] = parts;
  const match = minutePart.match(/^\*\/(\d+)$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 * 1000;
}
