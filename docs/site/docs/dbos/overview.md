---
title: DBOS Integration Overview
sidebar_position: 1
description: Durable job queues and cron scheduling backed by PostgreSQL — no Redis required.
---

# DBOS Integration

pgStack includes a lightweight DBOS (Durable Backoff and Operations System) module backed entirely by PostgreSQL. It provides a durable job queue and a cron-style scheduler — no Redis, RabbitMQ, or external dependencies required.

## What is it?

A **job queue** lets you offload work to background workers. Jobs are stored in a PostgreSQL table, claimed atomically using `SELECT ... FOR UPDATE SKIP LOCKED`, executed by worker processes, and retried automatically on failure.

A **scheduler** lets you run jobs on a cron-like schedule (every N minutes).

## Why PostgreSQL?

- **Durability.** Jobs survive crashes and restarts because they're rows in a database.
- **Atomicity.** Enqueue a job inside a database transaction — the job only exists if the transaction commits.
- **No extra services.** You already have PostgreSQL running. No additional infrastructure needed.
- **Observability.** Query `dbos.job_queue` directly to see job status, errors, and history.

## Installation

The DBOS client is included in `@pgstack/sdk`:

```bash
npm install @pgstack/sdk
# Requires the 'pg' driver for server-side use
npm install pg
```

## Schema bootstrap

The DBOS module creates its own schema. The canonical migration is `sdk/src/dbos/migration.sql` in the SDK package — apply it as-is rather than hand-maintaining a copy. It creates the job queue (including the `progress` / `progress_message` columns written by `reportProgress`), the `dbos.failed_jobs` dead-letter table (where permanently-failed jobs land after exhausting retries), and the workflow tables:

```sql
CREATE SCHEMA IF NOT EXISTS dbos;

CREATE TABLE IF NOT EXISTS dbos.job_queue (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name          text NOT NULL,
    payload           jsonb NOT NULL DEFAULT '{}',
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempt           int NOT NULL DEFAULT 0,
    max_attempts      int NOT NULL DEFAULT 3,
    progress          int,
    progress_message  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    scheduled_for     timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    error             text
);

-- Dead letter queue: permanently-failed jobs are moved here after exhausting retries.
CREATE TABLE IF NOT EXISTS dbos.failed_jobs (
    id                   uuid PRIMARY KEY,
    job_name             text NOT NULL,
    payload              jsonb NOT NULL DEFAULT '{}',
    attempt              int NOT NULL,
    max_attempts         int NOT NULL,
    error                text,
    original_created_at  timestamptz NOT NULL DEFAULT now(),
    failed_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dbos_job_queue_status_scheduled
    ON dbos.job_queue (status, scheduled_for)
    WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS dbos.workflow_executions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id text NOT NULL UNIQUE,
    status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    input       jsonb,
    output      jsonb,
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS dbos.workflow_steps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_exec_id uuid NOT NULL REFERENCES dbos.workflow_executions(id) ON DELETE CASCADE,
    step_name       text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    output          jsonb,
    error           text,
    attempt         int NOT NULL DEFAULT 0,
    started_at      timestamptz,
    completed_at    timestamptz,
    UNIQUE(workflow_exec_id, step_name)
);
```

Or run it with the CLI:

```bash
pgstack migration create bootstrap_dbos
# paste the SQL above into the migration file
pgstack migration run
```

## Quick example

```typescript
import { PgStackDBOS } from '@pgstack/sdk/dbos';

const dbos = new PgStackDBOS({
  connectionString: process.env.DATABASE_URL!,
  schema: 'dbos',       // default
  maxRetries: 3,        // default
  retryDelayMs: 1000,   // default, uses exponential backoff
});

// Register job handlers
dbos.queue.register('send-welcome-email', async (payload) => {
  const { email, name } = payload as { email: string; name: string };
  await sendEmail(email, 'Welcome!', `Hello ${name}, welcome to our app!`);
});

dbos.queue.register('process-payment', async (payload) => {
  const { orderId, amount } = payload as { orderId: string; amount: number };
  await stripeClient.charges.create({ amount, currency: 'usd' });
  await db.query('UPDATE orders SET status = $1 WHERE id = $2', ['paid', orderId]);
});

// Start the worker (polls every 5 seconds)
await dbos.start(5000);

// Enqueue jobs from your API handlers
await dbos.queue.enqueue('send-welcome-email', { email: 'user@example.com', name: 'Jane' });
await dbos.queue.enqueue('process-payment', { orderId: '123', amount: 4999 });
```

## Use with pgStack REST (transactional enqueue)

Because jobs are stored in PostgreSQL, you can enqueue them inside the same transaction as your data changes:

```typescript
// In a PostgreSQL function: insert order + enqueue payment job atomically
const { data } = await pgstack.rpc('place_order', {
  p_items: [{ product_id: 1, quantity: 2 }],
  p_payment_token: stripeToken,
});
// If place_order() calls dbos.job_queue INSERT in the same transaction,
// the job only exists if the order was committed.
```

```sql
-- SECURITY DEFINER with a pinned search_path of pg_catalog + pg_temp.
-- Every app-schema reference is fully qualified (public.orders,
-- dbos.job_queue, auth.uid) so a CREATE-on-public role cannot shadow
-- public.orders, jsonb_build_object, or auth.uid and run code as the
-- definer. Granting EXECUTE to authenticated is also explicit — the
-- pgStack bootstrap default-denies PUBLIC EXECUTE on functions
-- (see security defaults).
CREATE OR REPLACE FUNCTION public.place_order(p_items JSONB, p_payment_token TEXT)
RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_order public.orders;
BEGIN
  -- Insert the order
  INSERT INTO public.orders (user_id, status)
  VALUES (auth.uid(), 'pending')
  RETURNING * INTO v_order;

  -- Enqueue payment job in the same transaction
  INSERT INTO dbos.job_queue (job_name, payload)
  VALUES ('process-payment', jsonb_build_object(
    'orderId', v_order.id,
    'paymentToken', p_payment_token
  ));

  RETURN v_order;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_order(JSONB, TEXT) TO authenticated;
```

## Next steps

- [Job Queue](./job-queue) — registering handlers, enqueueing jobs, retries
- [Scheduler](./scheduler) — cron-style scheduling
