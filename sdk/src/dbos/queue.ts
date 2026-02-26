import type { Client as PgClient } from 'pg';
import type { PgStackDBOSConfig, JobQueueItem } from './types.js';

/**
 * Durable job queue backed by PostgreSQL.
 * Jobs survive crashes and are retried automatically.
 */
export class PgStackJobQueue {
  private config: Required<PgStackDBOSConfig>;
  private handlers: Map<string, (payload: unknown) => Promise<void>> = new Map();
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: PgStackDBOSConfig) {
    this.config = {
      schema: 'dbos',
      maxRetries: 3,
      retryDelayMs: 1000,
      ...config,
    };
  }

  private newClient(): PgClient {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    return new Client({ connectionString: this.config.connectionString });
  }

  /** Register a job handler */
  register(jobName: string, handler: (payload: unknown) => Promise<void>): this {
    this.handlers.set(jobName, handler);
    return this;
  }

  /** Enqueue a job for immediate or scheduled execution */
  async enqueue(
    jobName: string,
    payload: unknown,
    options?: {
      scheduledFor?: Date;
      maxAttempts?: number;
    },
  ): Promise<string> {
    const client = this.newClient();
    await client.connect();
    try {
      const result = await client.query<{ id: string }>(`
        INSERT INTO ${this.config.schema}.job_queue
          (job_name, payload, scheduled_for, max_attempts)
        VALUES ($1, $2, $3, $4)
        RETURNING id::text
      `, [
        jobName,
        JSON.stringify(payload),
        options?.scheduledFor ?? new Date(),
        options?.maxAttempts ?? this.config.maxRetries,
      ]);
      return result.rows[0].id;
    } finally {
      await client.end();
    }
  }

  /** Get job status by ID */
  async getJob(id: string): Promise<JobQueueItem | null> {
    const client = this.newClient();
    await client.connect();
    try {
      const result = await client.query<JobQueueItem>(`
        SELECT id::text, job_name, payload, status, attempt, max_attempts,
               created_at::text, scheduled_for::text, completed_at::text, error
        FROM ${this.config.schema}.job_queue WHERE id = $1::uuid
      `, [id]);
      return result.rows[0] ?? null;
    } finally {
      await client.end();
    }
  }

  /** List jobs with optional filter */
  async listJobs(filter?: { status?: string; limit?: number }): Promise<JobQueueItem[]> {
    const client = this.newClient();
    await client.connect();
    try {
      const where = filter?.status ? `WHERE status = $1` : '';
      const params = filter?.status ? [filter.status] : [];
      const limit = filter?.limit ?? 50;
      const result = await client.query<JobQueueItem>(`
        SELECT id::text, job_name, payload, status, attempt, max_attempts,
               created_at::text, scheduled_for::text, completed_at::text, error
        FROM ${this.config.schema}.job_queue
        ${where}
        ORDER BY scheduled_for ASC
        LIMIT ${limit}
      `, params);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  /**
   * Start the worker loop. Polls every `pollIntervalMs` ms (default 5000).
   * Claims and executes pending jobs. Retries failed jobs with exponential backoff.
   */
  async start(pollIntervalMs = 5000): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      this.poll().catch((e) => console.error('[pgstack-dbos] poll error:', e));
    }, pollIntervalMs);
    await this.poll(); // immediate first poll
  }

  /** Stop the worker loop */
  stop(): void {
    this.running = false;
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async poll(): Promise<void> {
    const client = this.newClient();
    await client.connect();
    try {
      // Claim one pending job atomically
      const result = await client.query<JobQueueItem>(`
        UPDATE ${this.config.schema}.job_queue
        SET status = 'running', attempt = attempt + 1
        WHERE id = (
          SELECT id FROM ${this.config.schema}.job_queue
          WHERE status IN ('pending', 'failed')
            AND attempt < max_attempts
            AND scheduled_for <= now()
          ORDER BY scheduled_for ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id::text, job_name, payload, attempt, max_attempts
      `);

      for (const job of result.rows) {
        await this.executeJob(job);
      }
    } catch (e) {
      console.error('[pgstack-dbos] poll error:', e);
    } finally {
      await client.end();
    }
  }

  private async executeJob(
    job: Partial<JobQueueItem> & { id: string; job_name: string },
  ): Promise<void> {
    const handler = this.handlers.get(job.job_name);
    if (!handler) {
      await this.markFailed(job.id, `No handler registered for job: ${job.job_name}`);
      return;
    }

    try {
      await handler(job.payload);
      await this.markCompleted(job.id);
    } catch (e) {
      const delay = this.config.retryDelayMs * Math.pow(2, (job.attempt ?? 1) - 1);
      await this.markFailed(job.id, String(e), new Date(Date.now() + delay));
    }
  }

  private async markCompleted(id: string): Promise<void> {
    const client = this.newClient();
    await client.connect();
    try {
      await client.query(`
        UPDATE ${this.config.schema}.job_queue
        SET status = 'completed', completed_at = now()
        WHERE id = $1::uuid
      `, [id]);
    } finally {
      await client.end();
    }
  }

  private async markFailed(id: string, error: string, retryAt?: Date): Promise<void> {
    const client = this.newClient();
    await client.connect();
    try {
      await client.query(`
        UPDATE ${this.config.schema}.job_queue
        SET status = CASE WHEN attempt >= max_attempts THEN 'failed'::text ELSE 'pending'::text END,
            error = $2,
            scheduled_for = COALESCE($3, scheduled_for)
        WHERE id = $1::uuid
      `, [id, error, retryAt ?? null]);
    } finally {
      await client.end();
    }
  }
}
