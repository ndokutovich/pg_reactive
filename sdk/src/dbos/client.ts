import { PgStackJobQueue } from './queue.js';
import { PgStackScheduler } from './scheduler.js';
import type { PgStackDBOSConfig } from './types.js';

/**
 * pgStack DBOS client — durable job queue and scheduler backed by PostgreSQL.
 *
 * @example
 * const dbos = new PgStackDBOS({ connectionString: process.env.DATABASE_URL! });
 *
 * // Register handlers
 * dbos.queue.register('send-welcome-email', async (payload) => {
 *   const { email } = payload as { email: string };
 *   await sendEmail(email, 'Welcome!', welcomeTemplate());
 * });
 *
 * // Schedule cron job
 * dbos.scheduler.schedule('cleanup-sessions', '*\/30 * * * *', async () => {
 *   await pgstack.from('sessions').delete().lt('expires_at', new Date().toISOString());
 * });
 *
 * // Start worker
 * await dbos.start();
 *
 * // Enqueue a job
 * await dbos.queue.enqueue('send-welcome-email', { email: 'user@example.com' });
 */
export class PgStackDBOS {
  public readonly queue: PgStackJobQueue;
  public readonly scheduler: PgStackScheduler;

  constructor(config: PgStackDBOSConfig) {
    this.queue = new PgStackJobQueue(config);
    this.scheduler = new PgStackScheduler(this.queue);
  }

  /** Start the job queue worker and scheduler */
  async start(pollIntervalMs = 5000): Promise<this> {
    await this.queue.start(pollIntervalMs);
    return this;
  }

  /** Stop all workers */
  stop(): void {
    this.queue.stop();
    this.scheduler.stop();
  }
}
