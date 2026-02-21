#include "postgres.h"

#include "catalog/pg_type.h"
#include "commands/async.h"
#include "executor/spi.h"
#include "lib/stringinfo.h"
#include "utils/builtins.h"
#include "pg_reactive.h"
#include "invalidation.h"
#include "recompute.h"

/* Max NOTIFY payload is 7999 bytes. We use 7800 as safe limit. */
#define PGR_NOTIFY_MAX_PAYLOAD	7800
#define PGR_NOTIFY_CHANNEL "pgr"

static char *pgr_build_delta_json(const char *query_id, const char *query_text);
static char *pgr_rows_to_json_array(SPITupleTable *tuptable, uint64 numrows,
									TupleDesc tupdesc);
static void pgr_json_escape_string(StringInfo buf, const char *value);

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

	for (i = 0; i < count; i++)
	{
		PgrDepEntry *entry;
		char		*delta_json;

		entry = pgr_dep_find(query_ids[i]);
		if (entry == NULL)
			continue;

		delta_json = pgr_build_delta_json(entry->query_id,
										  entry->query_text);

		if (delta_json != NULL)
		{
			if (strlen(delta_json) <= PGR_NOTIFY_MAX_PAYLOAD)
			{
				Async_Notify(PGR_NOTIFY_CHANNEL, delta_json);
			}
			else
			{
				StringInfoData overflow;

				initStringInfo(&overflow);
				appendStringInfo(&overflow,
								 "{\"type\":\"overflow\",\"query_id\":\"%s\",\"fetch\":true}",
								 entry->query_id);
				Async_Notify(PGR_NOTIFY_CHANNEL, overflow.data);
				pfree(overflow.data);
			}

			pfree(delta_json);

			/* Update per-entry stats */
			LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
			entry->last_invalidated = GetCurrentTimestamp();
			LWLockRelease(pgr_state->lock);
		}
	}
}

/*
 * Build a JSON delta object by comparing the snapshot table against
 * a fresh execution of the query.
 *
 * Returns a palloc'd JSON string like:
 * {"query_id":"q1","inserted":[...],"deleted":[...]}
 *
 * Returns NULL if no changes detected.
 */
static char *
pgr_build_delta_json(const char *query_id, const char *query_text)
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
	 * Compute inserted rows: new EXCEPT old
	 * (rows in current query result but not in snapshot)
	 */
	initStringInfo(&sql);
	appendStringInfo(&sql,
					 "(%s) EXCEPT (SELECT * FROM %s)",
					 query_text, snap_name.data);

	ret = SPI_execute(sql.data, true, 0);
	if (ret == SPI_OK_SELECT && SPI_processed > 0)
	{
		ins_count = SPI_processed;
		inserted_json = pgr_rows_to_json_array(SPI_tuptable, SPI_processed,
											   SPI_tuptable->tupdesc);
	}

	/*
	 * Compute deleted rows: old EXCEPT new
	 * (rows in snapshot but not in current query result)
	 */
	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "(SELECT * FROM %s) EXCEPT (%s)",
					 snap_name.data, query_text);

	ret = SPI_execute(sql.data, true, 0);
	if (ret == SPI_OK_SELECT && SPI_processed > 0)
	{
		del_count = SPI_processed;
		deleted_json = pgr_rows_to_json_array(SPI_tuptable, SPI_processed,
											  SPI_tuptable->tupdesc);
	}

	/* If no changes, skip notification */
	if (ins_count == 0 && del_count == 0)
	{
		pfree(snap_name.data);
		pfree(sql.data);
		return NULL;
	}

	/* Update the snapshot to the current state */
	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "DELETE FROM %s", snap_name.data);
	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
		elog(WARNING, "pg_reactive: failed to clear snapshot %s (SPI error %d)",
			 snap_name.data, ret);

	resetStringInfo(&sql);
	appendStringInfo(&sql,
					 "INSERT INTO %s %s", snap_name.data, query_text);
	ret = SPI_execute(sql.data, false, 0);
	if (ret < 0)
		elog(WARNING, "pg_reactive: failed to update snapshot %s (SPI error %d)",
			 snap_name.data, ret);

	/* Build result JSON */
	initStringInfo(&result);
	appendStringInfo(&result,
					 "{\"query_id\":\"%s\",\"inserted\":%s,\"deleted\":%s}",
					 query_id,
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
static void
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
			case '\t':
				appendStringInfoString(buf, "\\t");
				break;
			default:
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

			appendStringInfo(&buf, "\"%s\":", colname);

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
