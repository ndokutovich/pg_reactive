#include "postgres.h"

#include "catalog/pg_type.h"
#include "commands/async.h"
#include "executor/spi.h"
#include "lib/stringinfo.h"
#include "utils/builtins.h"
#include "pg_reactive.h"
#include "invalidation.h"
#include "recompute.h"

/*
 * PostgreSQL NOTIFY payload limit is NOTIFY_PAYLOAD_MAX_LENGTH (8000 chars).
 * We subtract the channel name length plus a small overhead margin (100 bytes)
 * to account for internal framing. The actual threshold is computed at runtime
 * using the configured pgr_notify_channel GUC.
 *
 * For the default channel "pgr" (3 chars): 8000 - 3 - 100 = 7897, rounded to 7900.
 * The macro below computes it dynamically from the channel name length.
 */
#define PGR_NOTIFY_OVERHEAD		100
#define PGR_NOTIFY_PAYLOAD_LIMIT	8000
#define PGR_NOTIFY_MAX_PAYLOAD_FOR_CHANNEL(ch) \
	((PGR_NOTIFY_PAYLOAD_LIMIT) - (int) strlen(ch) - PGR_NOTIFY_OVERHEAD)

static char *pgr_build_delta_json(const char *query_id, const char *query_text,
								  int64 seq);
static char *pgr_rows_to_json_array(SPITupleTable *tuptable, uint64 numrows,
									TupleDesc tupdesc);
/* pgr_json_escape_string declared extern in recompute.h */

/*
 * Return true if the given type OID represents a JSON-numeric type
 * (should be emitted without quotes).
 */
static inline bool
pgr_is_json_numeric_type(Oid typid)
{
	return typid == INT2OID || typid == INT4OID || typid == INT8OID ||
		   typid == FLOAT4OID || typid == FLOAT8OID || typid == NUMERICOID;
}

/*
 * Recompute a single query by query_id.
 * Handles both delta and notify modes.
 *
 * Must be called from within an SPI-connected context.
 */
void
pgr_recompute_query(const char *query_id)
{
	char		local_qid[PGR_QUERY_ID_LEN];
	char		local_qtext[PGR_QUERY_TEXT_LEN];
	char		local_mode;
	char		*delta_json;
	int64		seq;
	int			max_payload;

	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	/*
	 * Atomically increment seq and update stats under the exclusive lock.
	 * seq is a notification attempt counter — it increments whenever a
	 * trigger fires for this query. Clients detect missed notifications
	 * by observing gaps in the sequence.
	 * Returns -1 if the entry was removed (concurrent unsubscribe).
	 */
	seq = pgr_dep_increment_seq(query_id);
	if (seq < 0)
		return;

	/* Increment shared recompute counter */
	LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
	pgr_state->recompute_count++;
	LWLockRelease(pgr_state->lock);

	/*
	 * Copy entry fields into local buffers while holding the lock.
	 * The entry pointer from pgr_dep_find points into shared memory and
	 * can be invalidated by a concurrent pgr_dep_remove (HASH_REMOVE)
	 * after the lock is released. Copying under the lock prevents
	 * use-after-free on the shared hash entry.
	 */
	{
		PgrDepEntry *entry;
		bool		found;
		char		key[PGR_QUERY_ID_LEN];

		memset(key, 0, PGR_QUERY_ID_LEN);
		strlcpy(key, query_id, PGR_QUERY_ID_LEN);

		LWLockAcquire(pgr_state->lock, LW_SHARED);
		entry = (PgrDepEntry *) hash_search(pgr_dep_hash, key,
											HASH_FIND, &found);
		if (!found || entry == NULL)
		{
			LWLockRelease(pgr_state->lock);
			return;		/* removed between seq increment and find (benign) */
		}

		strlcpy(local_qid, entry->query_id, PGR_QUERY_ID_LEN);
		strlcpy(local_qtext, entry->query_text, PGR_QUERY_TEXT_LEN);
		local_mode = entry->mode;
		LWLockRelease(pgr_state->lock);
	}

	/* Compute payload limit for the configured channel */
	max_payload = PGR_NOTIFY_MAX_PAYLOAD_FOR_CHANNEL(pgr_notify_channel);

	/*
	 * Notify mode: lightweight invalidation, no query execution.
	 */
	if (local_mode == 'n')
	{
		StringInfoData inv;

		initStringInfo(&inv);
		appendStringInfoString(&inv,
							   "{\"type\":\"invalidated\",\"query_id\":");
		pgr_json_escape_string(&inv, local_qid);
		appendStringInfo(&inv, ",\"seq\":" INT64_FORMAT "}", seq);
		Async_Notify(pgr_notify_channel, inv.data);
		pfree(inv.data);
		return;
	}

	/* Delta mode: full EXCEPT-based diff computation */
	delta_json = pgr_build_delta_json(local_qid, local_qtext, seq);

	if (delta_json != NULL)
	{
		if ((int) strlen(delta_json) <= max_payload)
		{
			Async_Notify(pgr_notify_channel, delta_json);
		}
		else
		{
			StringInfoData overflow;

			initStringInfo(&overflow);
			appendStringInfoString(&overflow,
								   "{\"type\":\"overflow\",\"query_id\":");
			pgr_json_escape_string(&overflow, local_qid);
			appendStringInfo(&overflow,
							 ",\"seq\":" INT64_FORMAT ",\"fetch\":true}",
							 seq);
			Async_Notify(pgr_notify_channel, overflow.data);
			pfree(overflow.data);
		}

		pfree(delta_json);
	}
}

/*
 * Recompute all queries that depend on a given table.
 * Called from the trigger function (AFTER STATEMENT), where SPI is available.
 *
 * Must be called from within an SPI-connected context.
 */
void
pgr_recompute_for_table(Oid table_oid)
{
	char	query_ids[256][PGR_QUERY_ID_LEN];
	int		count;
	int		i;

	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	count = pgr_dep_find_by_table(table_oid, query_ids, 256);
	if (count == 0)
		return;

	{
		int safe_count = Min(count, 256);

		for (i = 0; i < safe_count; i++)
			pgr_recompute_query(query_ids[i]);
	}
}

/*
 * Build a JSON delta object by comparing the snapshot table against
 * a fresh execution of the query.
 *
 * Optimization: the user query is executed once into a temp table, then
 * the cached result is used for EXCEPT comparisons and snapshot refresh.
 * This avoids re-executing the (potentially expensive) user query 3 times.
 *
 * The seq parameter is embedded in the payload so clients can detect gaps.
 *
 * Returns a palloc'd JSON string like:
 * {"query_id":"q1","seq":N,"inserted":[...],"deleted":[...]}
 *
 * Returns NULL if no changes detected.
 */
static char *
pgr_build_delta_json(const char *query_id, const char *query_text,
					 int64 seq)
{
	StringInfoData	snap_name;
	StringInfoData	sql;
	StringInfoData	result;
	char		   *inserted_json = NULL;
	char		   *deleted_json = NULL;
	int				ret;
	uint64			ins_count = 0;
	uint64			del_count = 0;

	initStringInfo(&snap_name);
	appendStringInfo(&snap_name, "pgr.\"_snap_%s\"", query_id);

	/*
	 * Cache the user query result in a session-local temp table.
	 * This is the only execution of the user query — all subsequent
	 * operations use table scans on the cached result.
	 *
	 * Suppress NOTICE from DROP TABLE IF EXISTS when table doesn't exist.
	 */
	SPI_execute("SET LOCAL client_min_messages TO warning", false, 0);
	SPI_execute("DROP TABLE IF EXISTS _pgr_recompute", false, 0);
	SPI_execute("RESET client_min_messages", false, 0);

	initStringInfo(&sql);
	appendStringInfo(&sql,
					 "CREATE TEMP TABLE _pgr_recompute AS %s",
					 query_text);
	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
	{
		elog(WARNING, "pg_reactive: failed to cache query for %s", query_id);
		pfree(snap_name.data);
		pfree(sql.data);
		return NULL;
	}

	/*
	 * Compute inserted rows: cached EXCEPT snapshot (table scans only)
	 */
	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "(SELECT * FROM _pgr_recompute) EXCEPT (SELECT * FROM %s)",
					 snap_name.data);

	/*
	 * Use read_only=false so SPI gets a fresh GetTransactionSnapshot()
	 * that can see the temp table data (the active snapshot was pushed
	 * before CREATE TEMP TABLE and has a stale command counter).
	 */
	ret = SPI_execute(sql.data, false, 0);
	if (ret == SPI_OK_SELECT && SPI_processed > 0)
	{
		ins_count = SPI_processed;
		inserted_json = pgr_rows_to_json_array(SPI_tuptable, SPI_processed,
											   SPI_tuptable->tupdesc);
	}

	/*
	 * Compute deleted rows: snapshot EXCEPT cached (table scans only)
	 */
	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "(SELECT * FROM %s) EXCEPT (SELECT * FROM _pgr_recompute)",
					 snap_name.data);

	ret = SPI_execute(sql.data, false, 0);
	if (ret == SPI_OK_SELECT && SPI_processed > 0)
	{
		del_count = SPI_processed;
		deleted_json = pgr_rows_to_json_array(SPI_tuptable, SPI_processed,
											  SPI_tuptable->tupdesc);
	}

	/* If no changes, skip notification and cleanup */
	if (ins_count == 0 && del_count == 0)
	{
		SPI_execute("SET LOCAL client_min_messages TO warning", false, 0);
		SPI_execute("DROP TABLE IF EXISTS _pgr_recompute", false, 0);
		SPI_execute("RESET client_min_messages", false, 0);
		pfree(snap_name.data);
		pfree(sql.data);
		return NULL;
	}

	/* Refresh snapshot: DELETE + copy from cached result */
	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "DELETE FROM %s", snap_name.data);
	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
		elog(WARNING, "pg_reactive: failed to clear snapshot %s (SPI error %d)",
			 snap_name.data, ret);

	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "INSERT INTO %s SELECT * FROM _pgr_recompute",
					 snap_name.data);
	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
		elog(WARNING, "pg_reactive: failed to refresh snapshot %s (SPI error %d)",
			 snap_name.data, ret);

	/* Cleanup temp table */
	SPI_execute("SET LOCAL client_min_messages TO warning", false, 0);
	SPI_execute("DROP TABLE IF EXISTS _pgr_recompute", false, 0);
	SPI_execute("RESET client_min_messages", false, 0);

	/* Build result JSON — include seq for gap detection */
	initStringInfo(&result);
	appendStringInfoString(&result, "{\"query_id\":");
	pgr_json_escape_string(&result, query_id);
	appendStringInfo(&result,
					 ",\"seq\":" INT64_FORMAT ",\"inserted\":%s,\"deleted\":%s}",
					 seq,
					 inserted_json ? inserted_json : "[]",
					 deleted_json ? deleted_json : "[]");

	pfree(snap_name.data);
	pfree(sql.data);
	if (inserted_json)
		pfree(inserted_json);
	if (deleted_json)
		pfree(deleted_json);

	return result.data;
}

/*
 * Append a JSON-escaped string value (with surrounding quotes) to buf.
 */
void
pgr_json_escape_string(StringInfo buf, const char *value)
{
	const char *p;

	appendStringInfoChar(buf, '"');
	for (p = value; *p; p++)
	{
		switch (*p)
		{
			case '"':
				appendStringInfoString(buf, "\\\"");
				break;
			case '\\':
				appendStringInfoString(buf, "\\\\");
				break;
			case '\n':
				appendStringInfoString(buf, "\\n");
				break;
			case '\r':
				appendStringInfoString(buf, "\\r");
				break;
			case '\b':
				appendStringInfoString(buf, "\\b");
				break;
			case '\f':
				appendStringInfoString(buf, "\\f");
				break;
			case '\t':
				appendStringInfoString(buf, "\\t");
				break;
			default:
				if ((unsigned char)*p < 0x20)
				{
					char escape[7];
					snprintf(escape, sizeof(escape), "\\u%04x", (unsigned char)*p);
					appendStringInfoString(buf, escape);
				}
				else
					appendStringInfoChar(buf, *p);
				break;
		}
	}
	appendStringInfoChar(buf, '"');
}

/*
 * Convert SPI result rows to a JSON array string.
 * Each row becomes a JSON object with column names as keys.
 * Numeric types (int2/4/8, float4/8, numeric) are emitted unquoted.
 * Booleans are emitted as true/false.
 * Everything else is a quoted string.
 */
static char *
pgr_rows_to_json_array(SPITupleTable *tuptable, uint64 numrows,
						TupleDesc tupdesc)
{
	StringInfoData buf;
	uint64		i;
	int			natts = tupdesc->natts;

	initStringInfo(&buf);
	appendStringInfoChar(&buf, '[');

	for (i = 0; i < numrows; i++)
	{
		HeapTuple	tuple = tuptable->vals[i];
		int			j;

		if (i > 0)
			appendStringInfoChar(&buf, ',');

		appendStringInfoChar(&buf, '{');

		for (j = 1; j <= natts; j++)
		{
			char   *colname = NameStr(tupdesc->attrs[j - 1].attname);
			Oid		typid = tupdesc->attrs[j - 1].atttypid;
			char   *value;

			if (j > 1)
				appendStringInfoChar(&buf, ',');

			value = SPI_getvalue(tuple, tupdesc, j);

			pgr_json_escape_string(&buf, colname);
			appendStringInfoChar(&buf, ':');

			if (value == NULL)
			{
				appendStringInfoString(&buf, "null");
			}
			else if (typid == BOOLOID)
			{
				/* Emit true/false (PG returns "t"/"f") */
				appendStringInfoString(&buf,
									   (value[0] == 't') ? "true" : "false");
				pfree(value);
			}
			else if (pgr_is_json_numeric_type(typid))
			{
				/* Emit number without quotes */
				appendStringInfoString(&buf, value);
				pfree(value);
			}
			else
			{
				pgr_json_escape_string(&buf, value);
				pfree(value);
			}
		}

		appendStringInfoChar(&buf, '}');
	}

	appendStringInfoChar(&buf, ']');

	return buf.data;
}

/*
 * Create a snapshot table for a query by executing the query
 * and storing results in pgr._snap_<query_id>.
 *
 * Errors (e.g., invalid query) propagate to the caller.
 */
void
pgr_snapshot_create(const char *query_id, const char *query_text)
{
	StringInfoData sql;
	int		ret;

	/* Build SQL before SPI_connect so the buffer lives in the caller's
	 * memory context and survives SPI_finish(). */
	initStringInfo(&sql);
	appendStringInfo(&sql,
					 "CREATE UNLOGGED TABLE IF NOT EXISTS pgr.\"_snap_%s\" AS %s",
					 query_id, query_text);

	ret = SPI_connect();
	if (ret != SPI_OK_CONNECT)
	{
		pfree(sql.data);
		ereport(ERROR,
				(errcode(ERRCODE_INTERNAL_ERROR),
				 errmsg("pg_reactive: SPI_connect failed in snapshot_create: %d", ret)));
	}

	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
	{
		SPI_finish();
		pfree(sql.data);
		ereport(ERROR,
				(errcode(ERRCODE_INTERNAL_ERROR),
				 errmsg("pg_reactive: snapshot create failed (ret=%d)", ret)));
	}

	elog(DEBUG1, "pg_reactive: snapshot created for %s", query_id);

	SPI_finish();
	pfree(sql.data);
}

/*
 * Drop a snapshot table.
 */
void
pgr_snapshot_drop(const char *query_id)
{
	StringInfoData sql;

	/* Build SQL before SPI_connect so the buffer survives SPI_finish(). */
	initStringInfo(&sql);
	appendStringInfo(&sql,
					 "DROP TABLE IF EXISTS pgr.\"_snap_%s\"",
					 query_id);

	if (SPI_connect() != SPI_OK_CONNECT)
	{
		pfree(sql.data);
		return;
	}

	/* Suppress NOTICE from IF EXISTS when table doesn't exist */
	SPI_execute("SET LOCAL client_min_messages TO warning", false, 0);

	SPI_execute(sql.data, false, 0);

	SPI_finish();
	pfree(sql.data);
}

/*
 * No-op — recompute is now synchronous via trigger.
 * Kept for API compatibility.
 */
void
pgr_recompute_init_hooks(void)
{
	/* Nothing to do — recompute is driven by trigger, not xact callback */
}
