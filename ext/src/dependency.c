#include "postgres.h"

#include "access/xact.h"
#include "miscadmin.h"
#include "storage/ipc.h"
#include "storage/lwlock.h"
#include "storage/shmem.h"
#include "utils/hsearch.h"
#include "utils/memutils.h"
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
 * ── Transaction rollback journal (before-image) ─────────────────────────────
 *
 * Shared-memory mutations are NOT transactional. Every shmem add / update /
 * remove / LRU-eviction done by pgr_dep_add/pgr_dep_remove must be undone if
 * the (sub)transaction that made it aborts — otherwise:
 *   - an aborted subscribe leaves an orphan shmem entry with no catalog row;
 *   - an aborted re-subscribe (UPDATE) leaves the entry with the new,
 *     uncommitted audience/query while the catalog reverts — the proxy would
 *     read the stale shmem audience and could treat a protected subscription
 *     as public (Codex round-36 audit #1);
 *   - an aborted unsubscribe (REMOVE) leaves the catalog row without its
 *     shmem entry, so the query silently stops delivering.
 *
 * For each mutation we record a BEFORE-image (the entry as it was, or
 * "absent") tagged with the SubTransactionId that made it. On abort we replay
 * the before-images; on subtransaction commit we re-tag to the parent so a
 * later parent abort still reverts them. Journal records live in a dedicated
 * memory context (not the fixed-size array of the earlier fix, so there is no
 * cap and no orphan-on-overflow).
 */
typedef enum
{
	PGR_BEFORE_ABSENT,			/* key did not exist before the mutation */
	PGR_BEFORE_PRESENT			/* key existed; `before` holds its prior value */
} PgrBeforeKind;

typedef struct PgrJournalEntry
{
	struct PgrJournalEntry *next;	/* most-recent-first list */
	SubTransactionId subid;			/* subxact that made the mutation */
	PgrBeforeKind	kind;
	char			hashkey[PGR_HASHKEY_LEN];
	PgrDepEntry		before;			/* valid iff kind == PGR_BEFORE_PRESENT */
} PgrJournalEntry;

static PgrJournalEntry *pgr_journal = NULL;
static MemoryContext pgr_journal_ctx = NULL;
static bool pgr_cb_registered = false;

/*
 * Record the before-image of `hashkey` prior to mutating it. MUST be called
 * while holding pgr_state->lock so the captured image is consistent with the
 * mutation that follows.
 */
static void
pgr_journal_record(const char *hashkey)
{
	PgrJournalEntry *je;
	PgrDepEntry *cur;
	bool		found;
	MemoryContext old;

	if (pgr_journal_ctx == NULL)
		pgr_journal_ctx = AllocSetContextCreate(TopMemoryContext,
												"pg_reactive xact journal",
												ALLOCSET_SMALL_SIZES);

	old = MemoryContextSwitchTo(pgr_journal_ctx);
	je = (PgrJournalEntry *) palloc0(sizeof(PgrJournalEntry));
	MemoryContextSwitchTo(old);

	je->subid = GetCurrentSubTransactionId();
	strlcpy(je->hashkey, hashkey, PGR_HASHKEY_LEN);

	cur = (PgrDepEntry *) hash_search(pgr_dep_hash, hashkey, HASH_FIND, &found);
	if (found && cur != NULL)
	{
		je->kind = PGR_BEFORE_PRESENT;
		memcpy(&je->before, cur, sizeof(PgrDepEntry));
	}
	else
		je->kind = PGR_BEFORE_ABSENT;

	je->next = pgr_journal;
	pgr_journal = je;
}

/*
 * Apply (and unlink) journal records matching `pred`. Applying the list in
 * most-recent-first order means the EARLIEST before-image for a key is applied
 * last and wins, restoring the key's pre-transaction state. Caller holds the
 * lock. matchSubid < 0 means "all records" (top-level abort).
 */
static void
pgr_journal_revert(SubTransactionId matchSubid, bool matchAll)
{
	PgrJournalEntry **pp = &pgr_journal;

	while (*pp != NULL)
	{
		PgrJournalEntry *je = *pp;

		if (matchAll || je->subid == matchSubid)
		{
			if (je->kind == PGR_BEFORE_PRESENT)
			{
				bool		found;
				PgrDepEntry *e = (PgrDepEntry *) hash_search(pgr_dep_hash,
															 je->hashkey,
															 HASH_ENTER, &found);

				memcpy(e, &je->before, sizeof(PgrDepEntry));
			}
			else	/* PGR_BEFORE_ABSENT — undo the insert */
				hash_search(pgr_dep_hash, je->hashkey, HASH_REMOVE, NULL);

			*pp = je->next;
			pfree(je);
		}
		else
			pp = &je->next;
	}
}

static void
pgr_journal_discard(void)
{
	pgr_journal = NULL;
	if (pgr_journal_ctx != NULL)
		MemoryContextReset(pgr_journal_ctx);
}

static void
pgr_xact_callback(XactEvent event, void *arg)
{
	/*
	 * Round 37 F2: shared memory cannot participate in two-phase commit. The
	 * before-image journal is per-backend and is discarded at PREPARE, so a
	 * subsequent ROLLBACK PREPARED (potentially from another backend, after
	 * this one has exited) has nothing to revert — shmem would keep the
	 * prepared transaction's subscription mutations while the catalog rolls
	 * back, diverging exactly like the pre-journal bug this guards against.
	 * Forbid PREPARE for any transaction that touched the subscription
	 * registry. Fires at PRE_PREPARE so the ERROR aborts cleanly before the
	 * 2PC state file is written; the resulting ABORT then reverts the journal.
	 * No-op when the transaction never touched subscriptions (journal NULL).
	 */
	if (event == XACT_EVENT_PRE_PREPARE && pgr_journal != NULL)
		ereport(ERROR,
				(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
				 errmsg("pg_reactive: PREPARE TRANSACTION is not supported for transactions that modify live-query subscriptions"),
				 errdetail("Shared-memory subscription state cannot be rolled back by ROLLBACK PREPARED."),
				 errhint("COMMIT or ROLLBACK the transaction instead, or register subscriptions outside the prepared transaction.")));

	if (event == XACT_EVENT_ABORT || event == XACT_EVENT_PARALLEL_ABORT)
	{
		if (pgr_journal != NULL && pgr_state != NULL && pgr_dep_hash != NULL)
		{
			LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
			pgr_journal_revert(InvalidSubTransactionId, true);
			LWLockRelease(pgr_state->lock);
		}
	}

	/* Any terminal top-level event ends the journal window. */
	if (event == XACT_EVENT_COMMIT || event == XACT_EVENT_ABORT ||
		event == XACT_EVENT_PREPARE ||
		event == XACT_EVENT_PARALLEL_COMMIT || event == XACT_EVENT_PARALLEL_ABORT)
		pgr_journal_discard();
}

static void
pgr_subxact_callback(SubXactEvent event, SubTransactionId mySubid,
					 SubTransactionId parentSubid, void *arg)
{
	if (event == SUBXACT_EVENT_ABORT_SUB)
	{
		/* ROLLBACK TO SAVEPOINT: undo only this subtransaction's mutations. */
		if (pgr_journal != NULL && pgr_state != NULL && pgr_dep_hash != NULL)
		{
			LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
			pgr_journal_revert(mySubid, false);
			LWLockRelease(pgr_state->lock);
		}
	}
	else if (event == SUBXACT_EVENT_COMMIT_SUB)
	{
		/* The subxact committed into its parent; its mutations are now the
		 * parent's. Re-tag so a later parent abort still reverts them. */
		PgrJournalEntry *je;

		for (je = pgr_journal; je != NULL; je = je->next)
			if (je->subid == mySubid)
				je->subid = parentSubid;
	}
}

/*
 * Format the per-database hash key for a query_id. The shmem hash is shared
 * across the whole cluster, so the key must be scoped by MyDatabaseId to keep
 * subscriptions in different databases from colliding.
 */
void
pgr_dep_format_key(char *buf, Size buflen, const char *query_id)
{
	snprintf(buf, buflen, "%u/%s", (unsigned) MyDatabaseId, query_id);
}

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
	info.keysize = PGR_HASHKEY_LEN;
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
bool
pgr_dep_add(const char *query_id, const char *query_text,
			Oid *table_oids, uint64 *col_masks, int num_tables,
			char mode, const char *audience, PgrEvictedInfo *evicted)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_HASHKEY_LEN];

	if (evicted)
		evicted->evicted = false;

	if (num_tables > PGR_MAX_DEPS_PER_QUERY)
		ereport(ERROR,
				(errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
				 errmsg("pg_reactive: query depends on %d tables, max is %d",
						num_tables, PGR_MAX_DEPS_PER_QUERY)));

	/* Prepare per-database key */
	pgr_dep_format_key(key, sizeof(key), query_id);

	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);

	/* Journal the target's before-image (absent or its prior value) so an
	 * aborting (sub)transaction can undo this add/update. */
	pgr_journal_record(key);

	/*
	 * Check if key already exists — if so, we can update in place
	 * without worrying about capacity.
	 */
	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);

	if (!found &&
		hash_get_num_entries(pgr_dep_hash) >= (long) pgr_max_subscriptions)
	{
		/*
		 * At capacity and this is a new key — evict the oldest entry that
		 * belongs to THIS database. We must not evict another database's
		 * entry: the caller cleans up the evicted snapshot table and
		 * triggers in the current database, which would silently orphan a
		 * foreign database's objects. If the cluster-wide hash is full of
		 * other databases' entries and this one has none to reclaim, fail
		 * with the capacity error.
		 */
		HASH_SEQ_STATUS seq;
		PgrDepEntry *oldest = NULL;
		PgrDepEntry *scan;
		char		evict_key[PGR_HASHKEY_LEN];

		hash_seq_init(&seq, pgr_dep_hash);
		while ((scan = hash_seq_search(&seq)) != NULL)
		{
			if (scan->dbid != MyDatabaseId)
				continue;
			if (oldest == NULL ||
				scan->subscribed_at < oldest->subscribed_at)
				oldest = scan;
		}

		if (oldest == NULL)
		{
			/* No reclaimable entry in this database. */
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

		/* Remove the oldest entry (by its full per-database hash key) */
		memset(evict_key, 0, PGR_HASHKEY_LEN);
		strlcpy(evict_key, oldest->hashkey, PGR_HASHKEY_LEN);
		/* Journal the evicted entry too — if this txn aborts, the eviction
		 * must be undone (the victim's subscription legitimately existed). */
		pgr_journal_record(evict_key);
		hash_search(pgr_dep_hash, evict_key, HASH_REMOVE, NULL);
		pgr_state->eviction_count++;

		elog(LOG, "pg_reactive: evicted oldest subscription '%s'",
			 oldest->query_id);
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

	/* audience: empty string = no constraint, NULL passed = no constraint. */
	memset(entry->audience, 0, PGR_AUDIENCE_LEN);
	if (audience != NULL)
		strlcpy(entry->audience, audience, PGR_AUDIENCE_LEN);

	if (!found)
	{
		/* hashkey was copied into the entry by hash_search (HASH_STRINGS);
		 * record the owning database and the user-facing query_id. */
		entry->dbid = MyDatabaseId;
		strlcpy(entry->query_id, query_id, PGR_QUERY_ID_LEN);
		entry->subscribed_at = GetCurrentTimestamp();
		entry->last_invalidated = 0;
		entry->invalidation_count = 0;
		entry->notify_seq = 0;
		pgr_state->subscribe_count++;
	}

	LWLockRelease(pgr_state->lock);
	return true;
}

/*
 * Remove a dependency entry.
 * Returns true if found and removed.
 */
bool
pgr_dep_remove(const char *query_id)
{
	bool		found;
	char		key[PGR_HASHKEY_LEN];

	pgr_dep_format_key(key, sizeof(key), query_id);

	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);

	/* Journal the before-image so an aborting (sub)transaction re-inserts the
	 * entry — otherwise a rolled-back unsubscribe leaves the catalog row
	 * without its shmem entry. */
	pgr_journal_record(key);

	hash_search(pgr_dep_hash, key, HASH_REMOVE, &found);

	if (found)
		pgr_state->unsubscribe_count++;

	LWLockRelease(pgr_state->lock);
	return found;
}

/*
 * Find a dependency entry by query_id.
 * Returns true if found. If out is non-NULL, copies the entry data
 * into the caller-provided buffer while holding the lock.
 */
bool
pgr_dep_find(const char *query_id, PgrDepEntry *out)
{
	PgrDepEntry *entry;
	bool		found;
	char		key[PGR_HASHKEY_LEN];

	pgr_dep_format_key(key, sizeof(key), query_id);

	LWLockAcquire(pgr_state->lock, LW_SHARED);

	entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
										HASH_FIND, &found);
	if (found && out)
		memcpy(out, entry, sizeof(PgrDepEntry));

	LWLockRelease(pgr_state->lock);
	return found;
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
	char		key[PGR_HASHKEY_LEN];
	int			num_tables = 0;

	pgr_dep_format_key(key, sizeof(key), query_id);

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

		/* table OIDs are per-database; only match this database's entries */
		if (entry->dbid != MyDatabaseId)
			continue;

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
	char		key[PGR_HASHKEY_LEN];
	int64		seq;

	pgr_dep_format_key(key, sizeof(key), query_id);

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
	HASH_SEQ_STATUS seq;
	PgrDepEntry *entry;
	int			count = 0;

	/* Per-database count: each database sees only its own subscriptions. */
	LWLockAcquire(pgr_state->lock, LW_SHARED);
	hash_seq_init(&seq, pgr_dep_hash);
	while ((entry = hash_seq_search(&seq)) != NULL)
	{
		if (entry->dbid == MyDatabaseId)
			count++;
	}
	LWLockRelease(pgr_state->lock);

	return count;
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

	/* Revert non-transactional shmem mutations on (sub)transaction abort via
	 * the before-image journal. Registered once at module load. */
	if (!pgr_cb_registered)
	{
		RegisterXactCallback(pgr_xact_callback, NULL);
		RegisterSubXactCallback(pgr_subxact_callback, NULL);
		pgr_cb_registered = true;
	}
}
