---
title: Scheduler
sidebar_position: 3
description: Cron-style job scheduling backed by the pgStack job queue.
---

# Scheduler

The `PgStackScheduler` schedules jobs to run on a recurring interval using cron-like expressions. Scheduled jobs are executed through the job queue — they have the same durability, retry, and observability guarantees.

## Setup

```typescript
import { PgStackDBOS } from '@pgstack/sdk/dbos';

const dbos = new PgStackDBOS({
  connectionString: process.env.DATABASE_URL!,
});

const { scheduler, queue } = dbos;
```

## Scheduling jobs

```typescript
// Run every 5 minutes
scheduler.schedule('cleanup-expired-sessions', '*/5 * * * *', async () => {
  await db.query('DELETE FROM pgstack.sessions WHERE expires_at < now()');
  console.log('Cleaned up expired sessions');
});

// Run every 30 minutes
scheduler.schedule('send-digest-emails', '*/30 * * * *', async () => {
  const users = await getDigestRecipients();
  for (const user of users) {
    await queue.enqueue('send-digest', { userId: user.id });
  }
});

// Run every hour
scheduler.schedule('refresh-analytics', '*/60 * * * *', async () => {
  await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_summary');
});
```

## Cron expression format

pgStack currently supports simple interval patterns:

```
*/N * * * *   — run every N minutes
```

| Expression | Runs every |
|-----------|-----------|
| `*/1 * * * *` | 1 minute |
| `*/5 * * * *` | 5 minutes |
| `*/15 * * * *` | 15 minutes |
| `*/30 * * * *` | 30 minutes |
| `*/60 * * * *` | 1 hour |
| `*/1440 * * * *` | 24 hours |

For full cron expression support (e.g., `0 9 * * 1-5` for 9 AM on weekdays), install the optional `croner` package:

```bash
npm install croner
```

pgStack will automatically use it for richer expressions.

## Starting the scheduler and worker together

The scheduler enqueues cron jobs, but jobs are executed by the queue worker. Start both together:

```typescript
// Register handlers for both regular and cron jobs
queue.register('send-digest', sendDigestHandler);

// Set up scheduled jobs
scheduler.schedule('cleanup-sessions', '*/30 * * * *', async () => {
  await db.query('DELETE FROM pgstack.sessions WHERE expires_at < now()');
});

// Start worker (polls queue + triggers scheduler)
await dbos.start(5000);

// Graceful shutdown
process.on('SIGTERM', () => {
  dbos.stop();
  process.exit(0);
});
```

## Listing scheduled jobs

```typescript
const jobs = scheduler.listScheduled();
console.log(jobs);
// [{ name: 'cleanup-sessions', cron: '*/30 * * * *' }, ...]
```

## Stopping the scheduler

```typescript
// Stop all scheduled jobs
scheduler.stop();

// Stop everything (queue + scheduler)
dbos.stop();
```

## Full example: maintenance worker

```typescript
// maintenance-worker.ts

import { PgStackDBOS } from '@pgstack/sdk/dbos';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dbos = new PgStackDBOS({ connectionString: process.env.DATABASE_URL! });

// Register ad-hoc job handlers
dbos.queue.register('reindex-search', async () => {
  await pool.query(`
    UPDATE products
    SET search_vector = to_tsvector('english', name || ' ' || coalesce(description, ''))
    WHERE search_vector IS NULL
    LIMIT 1000
  `);
});

dbos.queue.register('send-weekly-report', async (payload) => {
  const { userId } = payload as { userId: string };
  const stats = await getUserWeeklyStats(userId);
  await sendEmail(stats.email, 'Your weekly summary', renderReport(stats));
});

// Schedule recurring maintenance tasks
dbos.scheduler.schedule('expire-sessions', '*/5 * * * *', async () => {
  const { rowCount } = await pool.query(
    'DELETE FROM pgstack.sessions WHERE expires_at < now()',
  );
  if (rowCount && rowCount > 0) {
    console.log(`Expired ${rowCount} sessions`);
  }
});

dbos.scheduler.schedule('refresh-rankings', '*/30 * * * *', async () => {
  await pool.query(
    'REFRESH MATERIALIZED VIEW CONCURRENTLY product_rankings',
  );
  console.log('Product rankings refreshed');
});

dbos.scheduler.schedule('queue-weekly-reports', '*/1440 * * * *', async () => {
  const { rows } = await pool.query(
    "SELECT id FROM pgstack.users WHERE weekly_reports = true",
  );
  for (const user of rows) {
    await dbos.queue.enqueue('send-weekly-report', { userId: user.id });
  }
  console.log(`Queued ${rows.length} weekly reports`);
});

// Start and keep running
await dbos.start(2000);
console.log('Maintenance worker started');

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  dbos.stop();
  await pool.end();
  process.exit(0);
});
```
