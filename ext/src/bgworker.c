#include "postgres.h"

#include "access/xact.h"
#include "executor/spi.h"
#include "miscadmin.h"
#include "pgstat.h"
#include "postmaster/bgworker.h"
#include "storage/ipc.h"
#include "storage/latch.h"
#include "storage/lwlock.h"
#include "storage/proc.h"
#include "storage/shmem.h"
#include "utils/builtins.h"
#include "utils/snapmgr.h"

#include "pg_reactive.h"
#include "bgworker.h"
#include "recompute.h"

/* Shared state */
PgrDirtyQueue *pgr_dirty_queue = NULL;

/* GUCs */
bool pgr_async_recompute = false;
char *pgr_database = "postgres";

/* Worker latch pointer (set when worker starts) */
static Latch *worker_latch = NULL;

/*
 * Shared memory size for the dirty queue.
 */
Size
pgr_bgworker_shmem_size(void)
{
	return MAXALIGN(sizeof(PgrDirtyQueue));
}

/*
 * Initialize the dirty queue in shared memory.
 * Called from pgr_shmem_startup (dependency.c).
 */
void
pgr_bgworker_shmem_startup(void)
{
	bool	found;

	pgr_dirty_queue = ShmemInitStruct("pg_reactive dirty queue",
									  sizeof(PgrDirtyQueue),
									  &found);
	if (!found)
	{
		SpinLockInit(&pgr_dirty_queue->mutex);
		pgr_dirty_queue->count = 0;
		memset(pgr_dirty_queue->table_oids, 0, sizeof(pgr_dirty_queue->table_oids));
	}
}

/*
 * Push a table OID to the shared dirty queue with deduplication.
 * Called from the xact callback on COMMIT in async mode.
 */
void
pgr_dirty_queue_push(Oid table_oid)
{
	int		i;

	if (pgr_dirty_queue == NULL)
		return;

	SpinLockAcquire(&pgr_dirty_queue->mutex);

	/* Deduplicate: check if already in queue */
	for (i = 0; i < pgr_dirty_queue->count; i++)
	{
		if (pgr_dirty_queue->table_oids[i] == table_oid)
		{
			SpinLockRelease(&pgr_dirty_queue->mutex);
			return;
		}
	}

	/* Add if space available */
	if (pgr_dirty_queue->count < PGR_DIRTY_QUEUE_SIZE)
	{
		pgr_dirty_queue->table_oids[pgr_dirty_queue->count] = table_oid;
		pgr_dirty_queue->count++;
	}
	else
	{
		/* Queue full — drop silently. The worker will catch up on next cycle. */
		elog(WARNING, "pg_reactive: async dirty queue full (%d), dropping table OID %u",
			 PGR_DIRTY_QUEUE_SIZE, table_oid);
	}

	SpinLockRelease(&pgr_dirty_queue->mutex);
}

/*
 * Signal the background worker to wake up.
 */
void
pgr_signal_worker(void)
{
	if (worker_latch != NULL)
		SetLatch(worker_latch);
}

/*
 * Drain the dirty queue atomically: copy all entries and reset count.
 * Returns the number of entries copied.
 */
static int
pgr_dirty_queue_drain(Oid *table_oids, int max_entries)
{
	int		count;

	if (pgr_dirty_queue == NULL)
		return 0;

	SpinLockAcquire(&pgr_dirty_queue->mutex);

	count = Min(pgr_dirty_queue->count, max_entries);
	if (count > 0)
	{
		memcpy(table_oids, pgr_dirty_queue->table_oids, count * sizeof(Oid));
		pgr_dirty_queue->count = 0;
	}

	SpinLockRelease(&pgr_dirty_queue->mutex);
	return count;
}

/*
 * Background worker main function.
 * Connects to the database, then loops: wait for signal, drain queue, recompute.
 */
PGDLLEXPORT void
pgr_bgworker_main(Datum main_arg)
{
	Oid			dirty_tables[PGR_DIRTY_QUEUE_SIZE];
	int			ndirty;
	int			i;

	/* Store our latch so backends can signal us */
	worker_latch = MyLatch;

	/* Unblock signals so we can respond to SIGTERM (graceful shutdown) */
	BackgroundWorkerUnblockSignals();

	/* Connect to the configured database */
	BackgroundWorkerInitializeConnection(pgr_database, NULL, 0);

	elog(LOG, "pg_reactive: background worker started");

	/* Main loop */
	for (;;)
	{
		/* Wait for latch signal or timeout (1 second poll as fallback) */
		(void) WaitLatch(MyLatch,
					   WL_LATCH_SET | WL_TIMEOUT | WL_EXIT_ON_PM_DEATH,
					   1000L,
					   PG_WAIT_EXTENSION);

		ResetLatch(MyLatch);

		CHECK_FOR_INTERRUPTS();

		/* Drain the queue */
		ndirty = pgr_dirty_queue_drain(dirty_tables, PGR_DIRTY_QUEUE_SIZE);
		if (ndirty == 0)
			continue;

		/* Process each dirty table in its own transaction with error handling */
		for (i = 0; i < ndirty; i++)
		{
			SetCurrentStatementStartTimestamp();
			StartTransactionCommand();
			PushActiveSnapshot(GetTransactionSnapshot());
			SPI_connect();

			PG_TRY();
			{
				pgr_recompute_for_table(dirty_tables[i]);
				SPI_finish();
				PopActiveSnapshot();
				CommitTransactionCommand();
			}
			PG_CATCH();
			{
				/* Log and swallow the error — don't crash the worker */
				EmitErrorReport();
				FlushErrorState();

				/* Abort the failed transaction so we can start fresh */
				AbortCurrentTransaction();

				elog(WARNING, "pg_reactive: async recompute failed for table OID %u",
					 dirty_tables[i]);
			}
			PG_END_TRY();
		}

		elog(DEBUG1, "pg_reactive: async recompute processed %d table(s)", ndirty);

		pgstat_report_activity(STATE_IDLE, NULL);
	}
}

/*
 * Register the background worker.
 * Called from _PG_init().
 */
void
pgr_bgworker_register(void)
{
	BackgroundWorker worker;

	memset(&worker, 0, sizeof(worker));
	snprintf(worker.bgw_name, BGW_MAXLEN, "pg_reactive worker");
	snprintf(worker.bgw_type, BGW_MAXLEN, "pg_reactive worker");
	snprintf(worker.bgw_library_name, BGW_MAXLEN, "pg_reactive");
	snprintf(worker.bgw_function_name, BGW_MAXLEN, "pgr_bgworker_main");
	worker.bgw_flags = BGWORKER_SHMEM_ACCESS | BGWORKER_BACKEND_DATABASE_CONNECTION;
	worker.bgw_start_time = BgWorkerStart_RecoveryFinished;
	worker.bgw_restart_time = 1;		/* restart within 1 second if crash */
	worker.bgw_main_arg = (Datum) 0;
	worker.bgw_notify_pid = 0;

	RegisterBackgroundWorker(&worker);
}
