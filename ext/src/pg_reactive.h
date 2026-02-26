#ifndef PG_REACTIVE_H
#define PG_REACTIVE_H

#include "postgres.h"
#include "fmgr.h"
#include "storage/lwlock.h"
#include "utils/hsearch.h"
#include "utils/timestamp.h"

/* Version */
#define PG_REACTIVE_VERSION "0.1"

/* Limits */
#define PGR_QUERY_ID_LEN        64
#define PGR_MAX_DEPS_PER_QUERY  16
#define PGR_QUERY_TEXT_LEN      2048

/* GUC variables */
extern int pgr_max_subscriptions;

/*
 * Column bitmask: bit N corresponds to attnum (N+1).
 * Supports up to 64 columns per table.
 * PGR_COL_MASK_ALL means "all columns" (e.g. SELECT *).
 */
#define PGR_COL_MASK_ALL	((uint64) ~0ULL)

/*
 * One entry in the dependency map: query_id -> tables it depends on.
 * Stored in shared memory hash table.
 */
typedef struct PgrDepEntry
{
	char		query_id[PGR_QUERY_ID_LEN];		/* hash key */
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	uint64		col_masks[PGR_MAX_DEPS_PER_QUERY];	/* column bitmask per table */
	int			num_tables;
	char		query_text[PGR_QUERY_TEXT_LEN];
	TimestampTz	subscribed_at;
	TimestampTz	last_invalidated;
	int64		invalidation_count;
	char		mode;			/* 'd' = delta, 'n' = notify */
} PgrDepEntry;

/*
 * Shared state header, protected by LWLock.
 */
typedef struct PgrSharedState
{
	LWLock	   *lock;
	int64		subscribe_count;	/* total subscribe calls */
	int64		unsubscribe_count;	/* total unsubscribe calls */
	int64		invalidation_count;	/* total invalidations */
	int64		eviction_count;		/* total LRU evictions */
} PgrSharedState;

/*
 * Info about an evicted subscription (for caller cleanup).
 */
typedef struct PgrEvictedInfo
{
	bool		evicted;
	char		query_id[PGR_QUERY_ID_LEN];
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	int			num_tables;
	char		mode;			/* mode of evicted entry */
} PgrEvictedInfo;

/* Global pointers to shared memory structures */
extern PgrSharedState *pgr_state;
extern HTAB *pgr_dep_hash;

/*
 * Validate a query_id for safe use in SQL identifiers.
 * Allows only alphanumeric characters, underscores, and hyphens.
 * Rejects NULL, empty, or overly long strings (max 64 chars).
 */
static inline bool
pgr_is_valid_query_id(const char *query_id)
{
	const char *p;

	if (query_id == NULL || query_id[0] == '\0')
		return false;
	if (strlen(query_id) > 64)
		return false;
	for (p = query_id; *p; p++)
	{
		if (!(*p >= 'a' && *p <= 'z') &&
			!(*p >= 'A' && *p <= 'Z') &&
			!(*p >= '0' && *p <= '9') &&
			*p != '_' && *p != '-')
			return false;
	}
	return true;
}

/* dependency.c */
extern void pgr_shmem_request(void);
extern void pgr_shmem_startup(void);
extern PgrDepEntry *pgr_dep_add(const char *query_id, const char *query_text,
								Oid *table_oids, uint64 *col_masks,
								int num_tables, char mode,
								PgrEvictedInfo *evicted);
extern bool pgr_dep_remove(const char *query_id);
extern PgrDepEntry *pgr_dep_find(const char *query_id);
extern int pgr_dep_copy_tables(const char *query_id, Oid *table_oids,
							   int max_tables);
extern int pgr_dep_find_by_table(Oid table_oid, char query_ids[][PGR_QUERY_ID_LEN],
								 int max_results);
extern int pgr_dep_count(void);
extern void pgr_dep_init_hooks(void);

#endif /* PG_REACTIVE_H */
