---
title: Job Queue
sidebar_position: 2
description: Durable background job queue backed by PostgreSQL with automatic retries.
---

# Job Queue

The `PgStackJobQueue` class provides a durable job queue backed by PostgreSQL.

## Setup

```typescript
import { PgStackDBOS } from '@pgstack/sdk/dbos';

const dbos = new PgStackDBOS({
  connectionString: process.env.DATABASE_URL!,
});

// Access the queue
const { queue } = dbos;
```

## Registering handlers

Register a handler for each job type before starting the worker:

```typescript
queue.register('send-welcome-email', async (payload) => {
  const { email } = payload as { email: string };
  await emailProvider.send({
    to: email,
    subject: 'Welcome!',
    html: '<p>Thanks for signing up!</p>',
  });
});

queue.register('generate-invoice', async (payload) => {
  const { orderId } = payload as { orderId: string };
  const pdf = await generateInvoicePdf(orderId);
  await storageProvider.upload(`invoices/${orderId}.pdf`, pdf);
  await db.query(
    'UPDATE orders SET invoice_url = $1 WHERE id = $2',
    [`/invoices/${orderId}.pdf`, orderId],
  );
});
```

Handlers are plain async functions. Throw an error to signal failure and trigger a retry.

Handlers receive a second argument, `reportProgress(progress, message?)`, for long-running jobs. It writes best-effort updates to the `progress` (clamped 0–100) and `progress_message` columns of `dbos.job_queue`; a failed progress update never fails the job.

```typescript
queue.register('import-csv', async (payload, reportProgress) => {
  reportProgress(0, 'starting');
  // ... import rows ...
  reportProgress(50, 'halfway');
  // ... import rows ...
  reportProgress(100, 'done');
});
```

## Starting the worker

```typescript
// Start polling (default: every 5 seconds)
await dbos.start();

// Custom poll interval (milliseconds)
await dbos.start(2000); // poll every 2 seconds

// Stop the worker
dbos.stop();
```

## Enqueueing jobs

```typescript
// Enqueue for immediate execution
const jobId = await queue.enqueue('send-welcome-email', {
  email: 'user@example.com',
  name: 'Jane Doe',
});

// Schedule for a future time
const jobId = await queue.enqueue('send-reminder', { userId: '123' }, {
  scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
});

// Custom max retries
const jobId = await queue.enqueue('critical-payment', { orderId: '456' }, {
  maxAttempts: 10,
});
```

## Checking job status

```typescript
const job = await queue.getJob(jobId);

console.log(job.status);    // 'pending' | 'running' | 'completed'
console.log(job.attempt);   // number of attempts so far
console.log(job.error);     // error message from last failure
console.log(job.completed_at); // ISO timestamp when completed
```

A job awaiting retry shows `'pending'` (with `error` set from its last failure). A job that exhausted all attempts is removed from `dbos.job_queue` entirely — see [Dead letter queue](#dead-letter-queue).

## Listing jobs

```typescript
// All pending jobs
const pending = await queue.listJobs({ status: 'pending' });

// Dead-lettered jobs (exceeded max retries)
const failed = await queue.listDeadLetterJobs(20);

// All recent jobs
const all = await queue.listJobs({ limit: 50 });
```

## Retry behavior

Jobs are retried automatically on failure using exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | 1 second |
| 2 | 2 seconds |
| 3 | 4 seconds |
| ... | doubles each time |

Configure the base delay and max attempts:

```typescript
const dbos = new PgStackDBOS({
  connectionString: process.env.DATABASE_URL!,
  maxRetries: 5,        // default: 3
  retryDelayMs: 2000,   // default: 1000ms
});
```

A job that exceeds `maxAttempts` is moved to the dead-letter table `dbos.failed_jobs` (removed from `dbos.job_queue`) and stops retrying. Inspect dead-lettered jobs with `queue.listDeadLetterJobs()` and re-queue one with `queue.retryDeadLetterJob(id)`.

## Dead letter queue

Jobs that exhaust `maxAttempts` are moved out of `dbos.job_queue` into `dbos.failed_jobs` — the dead letter queue:

```typescript
// Inspect dead-lettered jobs (most recent first, default limit 50)
const dead = await queue.listDeadLetterJobs(50);

// Replay one — moves it back to the queue with a fresh attempt counter
const newJobId = await queue.retryDeadLetterJob(dead[0].id);
```

`retryDeadLetterJob(id)` deletes the row from `dbos.failed_jobs` and inserts a new job with the same `job_name`, `payload`, and `max_attempts` in a single transaction, returning the new job ID. It throws if the ID is not found.

```sql
-- Dead-lettered jobs, newest first
SELECT job_name, payload, error, failed_at
FROM dbos.failed_jobs
ORDER BY failed_at DESC
LIMIT 20;
```

## Idempotency

Design your job handlers to be idempotent — safe to run multiple times with the same input. The queue guarantees at-least-once delivery, not exactly-once. Failures can cause the same job to run multiple times.

Pattern for idempotent jobs:

```typescript
queue.register('send-order-confirmation', async (payload) => {
  const { orderId } = payload as { orderId: string };

  // Check if we already sent this email
  const { rows } = await db.query(
    'SELECT id FROM email_log WHERE order_id = $1 AND type = $2',
    [orderId, 'order_confirmation'],
  );

  if (rows.length > 0) {
    console.log(`Email already sent for order ${orderId}, skipping`);
    return; // idempotent — already done
  }

  await emailProvider.sendOrderConfirmation(orderId);

  await db.query(
    'INSERT INTO email_log (order_id, type, sent_at) VALUES ($1, $2, now())',
    [orderId, 'order_confirmation'],
  );
});
```

## Observability

Query `dbos.job_queue` directly for monitoring:

```sql
-- Jobs by status
SELECT status, count(*) FROM dbos.job_queue GROUP BY status;

-- Permanently failed jobs (dead letter queue)
SELECT job_name, payload, error, attempt, max_attempts, original_created_at, failed_at
FROM dbos.failed_jobs
ORDER BY failed_at DESC
LIMIT 20;

-- Slow jobs (running for more than 5 minutes — may indicate hung workers)
SELECT job_name, payload, attempt, scheduled_for, now() - scheduled_for AS running_for
FROM dbos.job_queue
WHERE status = 'running'
  AND scheduled_for < now() - interval '5 minutes';

-- Throughput: jobs completed in the last hour
SELECT
  date_trunc('minute', completed_at) AS minute,
  count(*) AS jobs_completed
FROM dbos.job_queue
WHERE status = 'completed'
  AND completed_at > now() - interval '1 hour'
GROUP BY 1
ORDER BY 1;
```

### CLI

The `pgstack` CLI wraps the most common queue operations:

```bash
pgstack dbos status        # Job counts by status
pgstack dbos retry <id>    # Retry a failed job (resets it to pending)
pgstack dbos cancel <id>   # Cancel a pending or running job
```

## In-process worker vs separate process

The worker runs in the same Node.js process by default. For production, run it as a separate process to avoid impacting your web server:

```typescript
// worker.ts — separate entry point
import { PgStackDBOS } from '@pgstack/sdk/dbos';

const dbos = new PgStackDBOS({
  connectionString: process.env.DATABASE_URL!,
});

// Register all handlers
dbos.queue.register('send-email', sendEmailHandler);
dbos.queue.register('process-payment', processPaymentHandler);

// Start and keep running
await dbos.start(1000); // poll every second

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down worker...');
  dbos.stop();
  process.exit(0);
});
```

```bash
# Run the worker
node --loader ts-node/esm worker.ts
```
