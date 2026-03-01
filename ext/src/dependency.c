#include "postgres.h"

#include "miscadmin.h"
#include "storage/ipc.h"
#include "storage/lwlock.h"
#include "storage/shmem.h"
#include "utils/hsearch.h"
#include "utils/timestamp.h"

#include "pg_reactive.h"
#include "bgworker.h"

/* Shared state */
PgrSharedState *pgr_state = NULL;
HTAB *pgr_dep_hash = NULL;

/* Previous hooks */
static shmem_request_hook_type prev_shmem_request_hook = NULL;
static shmem_startup_hook_type prev_shmem_startup_hook = NULL;

/*
 * Estimate shared memory needed.
 */
static Size
pgr_shmem_size(void)
{
	Size		size;

	size = MAXALIGN(sizeof(PgrSharedState));
	size = add_size(size, hash_estimate_size(pgr_max_subscriptions,
											 sizeof(PgrDepEntry)));
	size = add_size(size, pgr_bgworker_shmem_size());
	return size;
}

/*
 * shmem_request_hook: request shared memory and LWLocks.
 */
void
pgr_shmem_request(void)
{
	if (prev_shmem_request_hook)
		prev_shmem_request_hook();

	RequestAddinShmemSpace(pgr_shmem_size());
	RequestNamedLWLockTranche("pg_reactive", 1);
}

/*
 * shmem_startup_hook: initialize shared memory structures.
 */
void
pgr_shmem_startup(void)
{
	HASHCTL		info;
	bool		found;

	if (prev_shmem_startup_hook)
		prev_shmem_startup_hook();

	LWLockAcquire(AddinShmemInitLock, LW_EXCLUSIVE);

	/* Initialize shared state header */
	pgr_state = ShmemInitStruct("pg_reactive state",
								sizeof(PgrSharedState),
								&found);
	if (!found)
	{
		pgr_state->lock = &(GetNamedLWLockTranche("pg_reactive"))[0].lock;
		pgr_state->subscribe_count = 0;
		pgr_state->unsubscribe_count = 0;
		pgr_state->invalidation_count = 0;
		pgr_state->eviction_count = 0;
		pgr_state->recompute_count = 0;
	}

	/* Initialize dependency hash table */
	memset(&info, 0, sizeof(info));
	info.keysize = PGR_QUERY_ID_LEN;
	info.entrysize = sizeof(PgrDepEntry);

	pgr_dep_hash = ShmemInitHash("pg_reactive deps",
								 pgr_max_subscriptions,
								 pgr_max_subscriptions,
								 &info,
								 HASH_ELEM | HASH_STRINGS);

	/* Initialize background worker dirty queue */
	pgr_bgworker_shmem_startup();

	LWLockRelease(AddinShmemInitLock);
}

/*
 * Add or update a dependency entry.
 * If the hash table is full, evicts the oldest entry (by subscribed_at)
 * and fills evicted info for caller cleanup.
 */
PgrDepEntry *
pgr_dep_add(const char *query_id, const char *query_text,
			Oid *table_oids, uint64 *col_masks, int num_tables,
			char mode, PgrEvictedInfo *evicted)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_QUERY_ID_LEN];

	if (evicted)
		evicted->evicted = false;

	if (num_tables > PGR_MAX_DEPS_PER_QUERY)
		ereport(ERROR,
				(errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
				 errmsg("pg_reactive: query depends on %d tables, max is %d",
						num_tables, PGR_MAX_DEPS_PER_QUERY)));

	/* Prepare key */
	memset(key, 0, PGR_QUERY_ID_LEN);
	strlcpy(key, query_id, PGR_QUERY_ID_LEN);

	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);

	/*
	 * Check if key already exists — if so, we can update in place
	 * without worrying about capacity.
	 */
	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);

	if (!found &&
		hash_get_num_entries(pgr_dep_hash) >= (long) pgr_max_subscriptions)
	{
		/* At capacity and this is a new key — evict oldest entry */
		HASH_SEQ_STATUS seq;
		PgrDepEntry *oldest = NULL;
		PgrDepEntry *scan;
		char		evict_key[PGR_QUERY_ID_LEN];

		hash_seq_init(&seq, pgr_dep_hash);
		while ((scan = hash_seq_search(&seq)) != NULL)
		{
			if (oldest == NULL ||
				scan->subscribed_at < oldest->subscribed_at)
				oldest = scan;
		}

		if (oldest == NULL)
		{
			/* Shouldn't happen — table is full but no entries? */
			LWLockRelease(pgr_state->lock);
			ereport(ERROR,
					(errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
					 errmsg("pg_reactive: max subscriptions (%d) reached",
							pgr_max_subscriptions)));
		}

		/* Save evicted info for caller cleanup */
		if (evicted)
		{
			evicted->evicted = true;
			strlcpy(evicted->query_id, oldest->query_id, PGR_QUERY_ID_LEN);
			evicted->num_tables = oldest->num_tables;
			memcpy(evicted->table_oids, oldest->table_oids,
				   oldest->num_tables * sizeof(Oid));
			evicted->mode = oldest->mode;
		}

		/* Remove the oldest entry */
		memset(evict_key, 0, PGR_QUERY_ID_LEN);
		strlcpy(evict_key, oldest->query_id, PGR_QUERY_ID_LEN);
		hash_search(pgr_dep_hash, evict_key, HASH_REMOVE, NULL);
		pgr_state->eviction_count++;

		elog(LOG, "pg_reactive: evicted oldest subscription '%s'",
			 evict_key);
	}

	/* Insert or find the entry */
	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_ENTER, &found);

	/* Fill or update the entry */
	strlcpy(entry->query_text, query_text, PGR_QUERY_TEXT_LEN);
	entry->num_tables = num_tables;
	memset(entry->table_oids, 0, sizeof(entry->table_oids));
	memcpy(entry->table_oids, table_oids, num_tables * sizeof(Oid));
	memset(entry->col_masks, 0, sizeof(entry->col_masks));
	memcpy(entry->col_masks, col_masks, num_tables * sizeof(uint64));

	entry->mode = mode;

	if (!found)
	{
		entry->subscribed_at = GetCurrentTimestamp();
		entry->last_invalidated = 0;
		entry->invalidation_count = 0;
		entry->notify_seq = 0;
		pgr_state->subscribe_count++;
	}

	LWLockRelease(pgr_state->lock);
	return entry;
}

/*
 * Remove a dependency entry.
 * Returns true if found and removed.
 */
bool
pgr_dep_remove(const char *query_id)
{
	bool		found;
	char		key[PGR_QUERY_ID_LEN];

	memset(key, 0, PGR_QUERY_ID_LEN);
	strlcpy(key, query_id, PGR_QUERY_ID_LEN);

	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);

	hash_search(pgr_dep_hash, key, HASH_REMOVE, &found);

	if (found)
		pgr_state->unsubscribe_count++;

	LWLockRelease(pgr_state->lock);
	return found;
}

/*
 * Find a dependency entry by query_id.
 * Returns NULL if not found.
 * Caller must hold at least LW_SHARED lock or accept race conditions.
 */
PgrDepEntry *
pgr_dep_find(const char *query_id)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_QUERY_ID_LEN];

	memset(key, 0, PGR_QUERY_ID_LEN);
	strlcpy(key, query_id, PGR_QUERY_ID_LEN);

	LWLockAcquire(pgr_state->lock, LW_SHARED);

	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);

	LWLockRelease(pgr_state->lock);
	return found ? entry : NULL;
}

/*
 * Copy table OIDs for a given query_id into caller-provided arrays.
 * Returns the number of tables, or 0 if not found.
 * Holds the lock during the copy, so the data is consistent.
 */
int
pgr_dep_copy_tables(const char *query_id, Oid *table_oids, int max_tables)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_QUERY_ID_LEN];
	int			num_tables = 0;

	memset(key, 0, PGR_QUERY_ID_LEN);
	strlcpy(key, query_id, PGR_QUERY_ID_LEN);

	LWLockAcquire(pgr_state->lock, LW_SHARED);

	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);
	if (found && entry != NULL)
	{
		num_tables = entry->num_tables;
		if (num_tables > max_tables)
			num_tables = max_tables;
		memcpy(table_oids, entry->table_oids, num_tables * sizeof(Oid));
	}

	LWLockRelease(pgr_state->lock);
	return num_tables;
}

/*
 * Find all query_ids that depend on a given table.
 * Returns the count of matching queries.
 * query_ids must be pre-allocated with max_results slots.
 */
int
pgr_dep_find_by_table(Oid table_oid, char query_ids[][PGR_QUERY_ID_LEN],
					  int max_results)
{
	HASH_SEQ_STATUS seq;
	PgrDepEntry *entry;
	int			count = 0;

	LWLockAcquire(pgr_state->lock, LW_SHARED);

	hash_seq_init(&seq, pgr_dep_hash);
	while ((entry = hash_seq_search(&seq)) != NULL)
	{
		int		i;

		for (i = 0; i < entry->num_tables; i++)
		{
			if (entry->table_oids[i] == table_oid)
			{
				if (count < max_results)
					strlcpy(query_ids[count], entry->query_id,
							PGR_QUERY_ID_LEN);
				count++;
				break;
			}
		}
	}

	LWLockRelease(pgr_state->lock);
	return count;
}

/*
 * Atomically increment the per-query sequence number and update stats.
 * Called from recompute.c before emitting a NOTIFY.
 *
 * Returns the new sequence value, or -1 if the entry was not found.
 * The sequence starts at 1 after the first notification.
 */
int64
pgr_dep_increment_seq(const char *query_id)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_QUERY_ID_LEN];
	int64		seq;

	memset(key, 0, PGR_QUERY_ID_LEN);
	strlcpy(key, query_id, PGR_QUERY_ID_LEN);

	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);

	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);

	if (!found || entry == NULL)
	{
		LWLockRelease(pgr_state->lock);
		return -1;
	}

	entry->notify_seq++;
	seq = entry->notify_seq;
	entry->last_invalidated = GetCurrentTimestamp();
	entry->invalidation_count++;

	LWLockRelease(pgr_state->lock);
	return seq;
}

/*
 * Count active subscriptions.
 */
int
pgr_dep_count(void)
{
	long		count;

	LWLockAcquire(pgr_state->lock, LW_SHARED);
	count = hash_get_num_entries(pgr_dep_hash);
	LWLockRelease(pgr_state->lock);

	return (int) count;
}

/*
 * Save and restore previous hooks for chaining.
 */
void
pgr_dep_init_hooks(void)
{
	prev_shmem_request_hook = shmem_request_hook;
	shmem_request_hook = pgr_shmem_request;

	prev_shmem_startup_hook = shmem_startup_hook;
	shmem_startup_hook = pgr_shmem_startup;
}
