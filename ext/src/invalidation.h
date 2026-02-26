#ifndef PGR_INVALIDATION_H
#define PGR_INVALIDATION_H

#include "postgres.h"

/* Maximum dirty queries per transaction */
#define PGR_MAX_DIRTY 256

/* Install base AFTER triggers (INSERT/DELETE) on a table */
extern void pgr_install_triggers(Oid table_oid);

/* Remove base pg_reactive triggers (INSERT/DELETE) from a table */
extern void pgr_remove_triggers(Oid table_oid);

/* Check if pg_reactive base triggers exist on a table */
extern bool pgr_has_triggers(Oid table_oid);

/* Install per-query UPDATE trigger with column list */
extern void pgr_install_update_trigger(Oid table_oid, const char *query_id,
										uint64 col_mask);

/* Remove per-query UPDATE trigger */
extern void pgr_remove_update_trigger(Oid table_oid, const char *query_id);

/* Install the ProcessUtility hook for DDL interception */
extern void pgr_invalidation_init_hooks(void);

/* Mark all queries depending on a table as dirty */
extern void pgr_invalidate_table(Oid table_oid);

/* Get list of currently dirty query_ids (for the current transaction) */
extern int pgr_get_dirty_queries(char query_ids[][64], int max_results);

/* Clear the dirty list (called on abort) */
extern void pgr_clear_dirty(void);

/*
 * Check whether any column in updated_mask overlaps with registered_mask.
 * registered_mask == PGR_COL_MASK_ALL means all columns are tracked.
 * Returns true if a recompute is warranted.
 *
 * This is a zero-overhead inline — no function call overhead in triggers.
 */
static inline bool
pgr_columns_overlap(uint64 registered_mask, uint64 updated_mask)
{
	/* All-columns mask: always overlaps */
	if (registered_mask == (uint64) ~0ULL)
		return true;
	/* updated_mask == 0 means no column info available — conservatively recompute */
	if (updated_mask == 0)
		return true;
	return (registered_mask & updated_mask) != 0;
}

#endif /* PGR_INVALIDATION_H */
