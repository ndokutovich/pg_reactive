-- pgStack DBOS schema bootstrap
-- Apply with: pgstack migration run
-- or: psql -f migration.sql

CREATE SCHEMA IF NOT EXISTS dbos;

CREATE TABLE IF NOT EXISTS dbos.job_queue (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name      text NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}',
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempt       int NOT NULL DEFAULT 0,
    max_attempts  int NOT NULL DEFAULT 3,
    created_at    timestamptz NOT NULL DEFAULT now(),
    scheduled_for timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    error         text
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
