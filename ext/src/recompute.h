#ifndef PGR_RECOMPUTE_H
#define PGR_RECOMPUTE_H

#include "postgres.h"

/* Initialize the recompute hooks */
extern void pgr_recompute_init_hooks(void);

/* Recompute all queries that depend on a table (called from trigger) */
extern void pgr_recompute_for_table(Oid table_oid);

/* Create a snapshot table for a query_id */
extern void pgr_snapshot_create(const char *query_id, const char *query_text);

/* Drop a snapshot table for a query_id */
extern void pgr_snapshot_drop(const char *query_id);

#endif /* PGR_RECOMPUTE_H */
