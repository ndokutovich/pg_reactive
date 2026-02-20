#ifndef PGR_BGWORKER_H
#define PGR_BGWORKER_H

#include "postgres.h"
#include "storage/spin.h"

/* Size of the shared dirty queue (table OIDs pending recompute) */
#define PGR_DIRTY_QUEUE_SIZE 4096

/*
 * Shared memory dirty queue.
 * Backends push table OIDs on COMMIT (async mode),
 * the background worker drains and recomputes.
 */
typedef struct PgrDirtyQueue
{
	slock_t		mutex;
	int			count;
	Oid			table_oids[PGR_DIRTY_QUEUE_SIZE];
} PgrDirtyQueue;

/* Pointer to shared memory queue (set during shmem_startup) */
extern PgrDirtyQueue *pgr_dirty_queue;

/* GUC: enable async recompute (default off) */
extern bool pgr_async_recompute;

/* GUC: database for background worker to connect to */
extern char *pgr_database;

/* Shared memory sizing */
extern Size pgr_bgworker_shmem_size(void);
extern void pgr_bgworker_shmem_startup(void);

/* Register the background worker (called from _PG_init) */
extern void pgr_bgworker_register(void);

/* Push a table OID to the shared dirty queue (deduplicating) */
extern void pgr_dirty_queue_push(Oid table_oid);

/* Signal the background worker to wake up */
extern void pgr_signal_worker(void);

/* Background worker entry point */
extern void pgr_bgworker_main(Datum main_arg);

#endif /* PGR_BGWORKER_H */
