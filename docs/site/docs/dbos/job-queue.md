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

console.log(job.status);    // 'pending' | 'running' | 'completed' | 'failed'
console.log(job.attempt);   // number of attempts so far
console.log(job.error);     // error message from last failure
console.log(job.completed_at); // ISO timestamp when completed
```

## Listing jobs

```typescript
// All pending jobs
const pending = await queue.listJobs({ status: 'pending' });

// Failed jobs (exceeded max retries)
const failed = await queue.listJobs({ status: 'failed', limit: 20 });

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

A job that exceeds `maxAttempts` transitions to `'failed'` status and stops retrying.

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

-- Failed jobs with errors
SELECT job_name, payload, error, attempt, max_attempts, created_at
FROM dbos.job_queue
WHERE status = 'failed'
ORDER BY created_at DESC
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
