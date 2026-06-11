#ifndef PG_REACTIVE_H
#define PG_REACTIVE_H

#include "postgres.h"
#include "fmgr.h"
#include "storage/lwlock.h"
#include "utils/hsearch.h"
#include "utils/timestamp.h"

/* Version */
#define PG_REACTIVE_VERSION "0.1.2"

/* Limits */
#define PGR_QUERY_ID_LEN        64
#define PGR_MAX_DEPS_PER_QUERY  16
#define PGR_QUERY_TEXT_LEN      2048
#define PGR_AUDIENCE_LEN        512	/* serialised JSON audience predicate */
/*
 * The shmem hash is shared across ALL databases in the cluster, so the key
 * must include the database OID — otherwise two databases that register the
 * same query_id collide and silently overwrite each other (and table OIDs,
 * which are also per-database, alias in the reverse index). The key is the
 * string "<dbid>/<query_id>"; 12 bytes covers "/" + a 32-bit OID + NUL.
 */
#define PGR_HASHKEY_LEN         (PGR_QUERY_ID_LEN + 12)

/* GUC variables */
extern int pgr_max_subscriptions;
extern char *pgr_notify_channel;
extern bool pgr_batch_invalidation;

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
	char		hashkey[PGR_HASHKEY_LEN];		/* hash key: "<dbid>/<query_id>" */
	Oid			dbid;			/* owning database (MyDatabaseId at subscribe) */
	char		query_id[PGR_QUERY_ID_LEN];		/* user-facing id (display) */
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	uint64		col_masks[PGR_MAX_DEPS_PER_QUERY];	/* column bitmask per table */
	int			num_tables;
	char		query_text[PGR_QUERY_TEXT_LEN];
	TimestampTz	subscribed_at;
	TimestampTz	last_invalidated;
	int64		invalidation_count;
	char		mode;			/* 'd' = delta, 'n' = notify */
	int64		notify_seq;		/* per-query sequence number for gap detection */
	/*
	 * audience: optional JSON object enforced by the proxy at WS-connect time.
	 * Empty string means "no audience constraint" (public; the legacy
	 * behaviour). When non-empty, the proxy parses this JSON and requires
	 * every key to match the corresponding JWT claim. service_role JWTs
	 * always bypass. Stored as serialised JSON text to keep the entry POD.
	 */
	char		audience[PGR_AUDIENCE_LEN];
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
	int64		recompute_count;	/* total recomputes executed */
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
/* Format the per-database hash key "<MyDatabaseId>/<query_id>" into buf. */
extern void pgr_dep_format_key(char *buf, Size buflen, const char *query_id);
extern bool pgr_dep_add(const char *query_id, const char *query_text,
						Oid *table_oids, uint64 *col_masks,
						int num_tables, char mode,
						const char *audience,
						PgrEvictedInfo *evicted);
extern bool pgr_dep_remove(const char *query_id);
extern bool pgr_dep_find(const char *query_id, PgrDepEntry *out);
extern int pgr_dep_copy_tables(const char *query_id, Oid *table_oids,
							   int max_tables);
extern int pgr_dep_find_by_table(Oid table_oid, char query_ids[][PGR_QUERY_ID_LEN],
								 int max_results);
extern int pgr_dep_count(void);
extern void pgr_dep_init_hooks(void);
extern int64 pgr_dep_increment_seq(const char *query_id);

/* pg_reactive.c — DDL auto-cleanup */
/* reason is appended to the log WARNING (e.g. "DROP TABLE on foo"); NULL suppresses WARNING */
extern void pgr_unsubscribe_all_for_table(Oid table_oid, const char *reason);

#endif /* PG_REACTIVE_H */
