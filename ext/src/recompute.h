#ifndef PGR_RECOMPUTE_H
#define PGR_RECOMPUTE_H

#include "postgres.h"
#include "lib/stringinfo.h"

/* Initialize the recompute hooks */
extern void pgr_recompute_init_hooks(void);

/* Recompute all queries that depend on a table (called from trigger) */
extern void pgr_recompute_for_table(Oid table_oid);

/* Recompute a single query by query_id (called from batch commit) */
extern void pgr_recompute_query(const char *query_id);

/* Create a snapshot table for a query_id */
extern void pgr_snapshot_create(const char *query_id, const char *query_text);

/* Drop a snapshot table for a query_id */
extern void pgr_snapshot_drop(const char *query_id);

/* Append a JSON-escaped string value (with surrounding quotes) to buf */
extern void pgr_json_escape_string(StringInfo buf, const char *value);

#endif /* PGR_RECOMPUTE_H */
