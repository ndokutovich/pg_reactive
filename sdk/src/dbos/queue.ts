import type { Client as PgClient } from 'pg';
import type { PgStackDBOSConfig, JobQueueItem } from './types.js';

export type JobProgressFn = (progress: number, message?: string) => void;
export type JobHandler = (payload: unknown, reportProgress: JobProgressFn) => Promise<void>;

/**
 * Durable job queue backed by PostgreSQL.
 * Jobs survive crashes and are retried automatically.
 */
export class PgStackJobQueue {
  private config: Required<PgStackDBOSConfig>;
  private handlers: Map<string, JobHandler> = new Map();
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

  /** Register a job handler. The handler receives (payload, reportProgress). */
  register(jobName: string, handler: JobHandler): this {
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
      // Claim one pending job atomically using advisory lock to prevent
      // duplicate execution across multiple workers on the same PG instance.
      const result = await client.query<JobQueueItem>(`
        UPDATE ${this.config.schema}.job_queue
        SET status = 'running', attempt = attempt + 1
        WHERE id = (
          SELECT id FROM ${this.config.schema}.job_queue
          WHERE status IN ('pending', 'failed')
            AND attempt < max_attempts
            AND scheduled_for <= now()
            AND pg_try_advisory_lock(hashtext(id::text))
          ORDER BY scheduled_for ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id::text, job_name, payload, attempt, max_attempts
      `);

      for (const job of result.rows) {
        await this.executeJob(job, client);
        // Release advisory lock after job completes
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [job.id]);
      }
    } catch (e) {
      console.error('[pgstack-dbos] poll error:', e);
    } finally {
      await client.end();
    }
  }

  private async executeJob(
    job: Partial<JobQueueItem> & { id: string; job_name: string },
    lockClient: PgClient,
  ): Promise<void> {
    const handler = this.handlers.get(job.job_name);
    if (!handler) {
      await this.moveToDeadLetter(job.id, `No handler registered for job: ${job.job_name}`);
      return;
    }

    const reportProgress: JobProgressFn = (progress, message) => {
      lockClient.query(
        `UPDATE ${this.config.schema}.job_queue SET progress = $2, progress_message = $3 WHERE id = $1::uuid`,
        [job.id, Math.min(100, Math.max(0, progress)), message ?? null],
      ).catch(() => { /* progress update is best-effort; job still runs if this fails */ });
    };

    try {
      await handler(job.payload, reportProgress);
      await this.markCompleted(job.id);
    } catch (e) {
      const attempt = job.attempt ?? 1;
      const maxAttempts = job.max_attempts ?? this.config.maxRetries;
      if (attempt >= maxAttempts) {
        await this.moveToDeadLetter(job.id, String(e));
      } else {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
        await this.markFailed(job.id, String(e), new Date(Date.now() + delay));
      }
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
        SET status = 'pending',
            error = $2,
            scheduled_for = COALESCE($3, scheduled_for)
        WHERE id = $1::uuid
      `, [id, error, retryAt ?? null]);
    } finally {
      await client.end();
    }
  }

  /**
   * Move a permanently-failed job to the dead letter queue.
   * The job is deleted from job_queue and inserted into failed_jobs.
   */
  private async moveToDeadLetter(id: string, error: string): Promise<void> {
    const client = this.newClient();
    await client.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<JobQueueItem>(`
        DELETE FROM ${this.config.schema}.job_queue WHERE id = $1::uuid
        RETURNING job_name, payload, attempt, max_attempts, created_at
      `, [id]);
      if (rows.length > 0) {
        const j = rows[0];
        await client.query(`
          INSERT INTO ${this.config.schema}.failed_jobs
            (id, job_name, payload, attempt, max_attempts, error, original_created_at)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
        `, [id, j.job_name, j.payload, j.attempt, j.max_attempts, error, j.created_at]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[pgstack-dbos] DLQ insert failed:', e);
    } finally {
      await client.end();
    }
  }

  /** List jobs in the dead letter queue */
  async listDeadLetterJobs(limit = 50): Promise<JobQueueItem[]> {
    const client = this.newClient();
    await client.connect();
    try {
      const result = await client.query<JobQueueItem>(`
        SELECT id::text, job_name, payload, 'failed' AS status, attempt, max_attempts,
               original_created_at::text AS created_at, failed_at::text AS completed_at, error
        FROM ${this.config.schema}.failed_jobs
        ORDER BY failed_at DESC
        LIMIT ${limit}
      `);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  /** Retry a dead letter job by moving it back to the queue */
  async retryDeadLetterJob(id: string): Promise<string> {
    const client = this.newClient();
    await client.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<JobQueueItem>(`
        DELETE FROM ${this.config.schema}.failed_jobs WHERE id = $1::uuid
        RETURNING job_name, payload, max_attempts
      `, [id]);
      if (rows.length === 0) throw new Error(`DLQ job ${id} not found`);
      const j = rows[0];
      const { rows: newRows } = await client.query<{ id: string }>(`
        INSERT INTO ${this.config.schema}.job_queue (job_name, payload, max_attempts)
        VALUES ($1, $2, $3) RETURNING id::text
      `, [j.job_name, j.payload, j.max_attempts]);
      await client.query('COMMIT');
      return newRows[0].id;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      await client.end();
    }
  }
}
