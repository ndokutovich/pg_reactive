export type WorkflowFn<T> = (...args: unknown[]) => Promise<T>;
export type StepFn<T> = (...args: unknown[]) => Promise<T>;

export interface WorkflowContext {
  workflowId: string;
  step<T>(name: string, fn: StepFn<T>): Promise<T>;
}

export interface JobQueueItem {
  id: string;
  job_name: string;
  payload: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt: number;
  max_attempts: number;
  created_at: string;
  scheduled_for: string;
  completed_at: string | null;
  error: string | null;
}

export interface ScheduledJob {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export interface PgStackDBOSConfig {
  /** PostgreSQL connection string. Defaults to DATABASE_URL env var. */
  connectionString: string;
  /** Schema for DBOS tables. Default: 'dbos' */
  schema?: string;
  /** Max retry attempts for steps. Default: 3 */
  maxRetries?: number;
  /** Base retry delay ms. Default: 1000 */
  retryDelayMs?: number;
}
