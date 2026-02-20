#include "postgres.h"

#include "catalog/namespace.h"
#include "catalog/pg_class.h"
#include "fmgr.h"
#include "funcapi.h"
#include "miscadmin.h"
#include "parser/analyze.h"
#include "parser/parser.h"
#include "utils/builtins.h"
#include "utils/guc.h"
#include "utils/lsyscache.h"

#include "pg_reactive.h"
#include "invalidation.h"
#include "recompute.h"
#include "bgworker.h"

PG_MODULE_MAGIC;

/* GUC variable */
int pgr_max_subscriptions = 1024;

void _PG_init(void);

/*
 * Extract table OIDs from a query by parsing it and looking at the
 * RangeVar nodes in the raw parse tree.
 */
static int
pgr_extract_tables(const char *query_text, Oid *table_oids, int max_tables)
{
	List	   *raw_parsetree_list;
	ListCell   *lc;
	int			count = 0;

	raw_parsetree_list = raw_parser(query_text, RAW_PARSE_DEFAULT);

	foreach(lc, raw_parsetree_list)
	{
		RawStmt	   *rawstmt = lfirst_node(RawStmt, lc);
		SelectStmt *sel;
		ListCell   *fc;

		if (!IsA(rawstmt->stmt, SelectStmt))
			continue;

		sel = (SelectStmt *) rawstmt->stmt;

		foreach(fc, sel->fromClause)
		{
			Node	   *n = lfirst(fc);

			if (IsA(n, RangeVar))
			{
				RangeVar   *rv = (RangeVar *) n;
				Oid			relid;

				relid = RangeVarGetRelid(rv, NoLock, true);
				if (OidIsValid(relid) && count < max_tables)
					table_oids[count++] = relid;
			}
			else if (IsA(n, JoinExpr))
			{
				JoinExpr   *j = (JoinExpr *) n;

				if (IsA(j->larg, RangeVar))
				{
					RangeVar *rv = (RangeVar *) j->larg;
					Oid relid = RangeVarGetRelid(rv, NoLock, true);
					if (OidIsValid(relid) && count < max_tables)
						table_oids[count++] = relid;
				}
				if (IsA(j->rarg, RangeVar))
				{
					RangeVar *rv = (RangeVar *) j->rarg;
					Oid relid = RangeVarGetRelid(rv, NoLock, true);
					if (OidIsValid(relid) && count < max_tables)
						table_oids[count++] = relid;
				}
			}
		}
	}

	return count;
}

/*
 * SQL function: pgr.subscribe(query_id text, query text) -> jsonb
 */
PG_FUNCTION_INFO_V1(pgr_subscribe);
Datum
pgr_subscribe(PG_FUNCTION_ARGS)
{
	text	   *query_id_text = PG_GETARG_TEXT_PP(0);
	text	   *query_text = PG_GETARG_TEXT_PP(1);
	char	   *query_id = text_to_cstring(query_id_text);
	char	   *query_str = text_to_cstring(query_text);
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	int			num_tables;
	StringInfoData buf;

	/* Validate query_id length */
	if (strlen(query_id) >= PGR_QUERY_ID_LEN)
		ereport(ERROR,
				(errcode(ERRCODE_STRING_DATA_RIGHT_TRUNCATION),
				 errmsg("query_id too long (max %d characters)",
						PGR_QUERY_ID_LEN - 1)));

	/* Parse the query to extract table references */
	num_tables = pgr_extract_tables(query_str, table_oids,
									PGR_MAX_DEPS_PER_QUERY);

	if (num_tables == 0)
		ereport(ERROR,
				(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
				 errmsg("could not extract any table references from query")));

	/* Create snapshot table first — validates the query and fails early
	 * if the query is invalid (before we touch shared memory). */
	pgr_snapshot_create(query_id, query_str);

	/* Register in shared memory (only after snapshot succeeds) */
	pgr_dep_add(query_id, query_str, table_oids, num_tables);

	/* Install triggers on any tables that don't have them yet */
	{
		int		i;
		for (i = 0; i < num_tables; i++)
		{
			if (!pgr_has_triggers(table_oids[i]))
				pgr_install_triggers(table_oids[i]);
		}
	}

	/* Build JSON result */
	initStringInfo(&buf);
	appendStringInfo(&buf,
					 "{\"query_id\": \"%s\", \"tables\": %d, \"status\": \"subscribed\"}",
					 query_id, num_tables);

	PG_RETURN_DATUM(DirectFunctionCall1(jsonb_in,
										CStringGetDatum(buf.data)));
}

/*
 * SQL function: pgr.unsubscribe(query_id text) -> boolean
 */
PG_FUNCTION_INFO_V1(pgr_unsubscribe);
Datum
pgr_unsubscribe(PG_FUNCTION_ARGS)
{
	text	   *query_id_text = PG_GETARG_TEXT_PP(0);
	char	   *query_id = text_to_cstring(query_id_text);
	PgrDepEntry *entry;
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	int			num_tables = 0;
	bool		found;

	/* Before removing, save the table OIDs so we can check trigger cleanup */
	entry = pgr_dep_find(query_id);
	if (entry != NULL)
	{
		num_tables = entry->num_tables;
		memcpy(table_oids, entry->table_oids, num_tables * sizeof(Oid));
	}

	found = pgr_dep_remove(query_id);

	/* Drop the snapshot table */
	if (found)
		pgr_snapshot_drop(query_id);

	/* Check if any remaining subscriptions reference these tables */
	if (found)
	{
		int		i;
		char	dummy[1][PGR_QUERY_ID_LEN];

		for (i = 0; i < num_tables; i++)
		{
			int remaining = pgr_dep_find_by_table(table_oids[i], dummy, 1);
			if (remaining == 0)
				pgr_remove_triggers(table_oids[i]);
		}
	}

	PG_RETURN_BOOL(found);
}

/*
 * SQL function: pgr.get_subscriptions() -> SETOF record
 */
PG_FUNCTION_INFO_V1(pgr_get_subscriptions);
Datum
pgr_get_subscriptions(PG_FUNCTION_ARGS)
{
	FuncCallContext *funcctx;
	HASH_SEQ_STATUS *seq;
	PgrDepEntry *entry;

	if (SRF_IS_FIRSTCALL())
	{
		MemoryContext oldcontext;
		TupleDesc	tupdesc;

		funcctx = SRF_FIRSTCALL_INIT();
		oldcontext = MemoryContextSwitchTo(funcctx->multi_call_memory_ctx);

		tupdesc = CreateTemplateTupleDesc(5);
		TupleDescInitEntry(tupdesc, (AttrNumber) 1, "query_id",
						   TEXTOID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 2, "query_text",
						   TEXTOID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 3, "num_tables",
						   INT4OID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 4, "subscribed_at",
						   TIMESTAMPTZOID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 5, "invalidation_count",
						   INT8OID, -1, 0);

		funcctx->tuple_desc = BlessTupleDesc(tupdesc);

		/* Start hash scan */
		seq = (HASH_SEQ_STATUS *) palloc(sizeof(HASH_SEQ_STATUS));
		LWLockAcquire(pgr_state->lock, LW_SHARED);
		hash_seq_init(seq, pgr_dep_hash);
		funcctx->user_fctx = seq;

		MemoryContextSwitchTo(oldcontext);
	}

	funcctx = SRF_PERCALL_SETUP();
	seq = (HASH_SEQ_STATUS *) funcctx->user_fctx;

	entry = (PgrDepEntry *) hash_seq_search(seq);

	if (entry != NULL)
	{
		Datum		values[5];
		bool		nulls[5];
		HeapTuple	tuple;

		memset(nulls, 0, sizeof(nulls));
		values[0] = CStringGetTextDatum(entry->query_id);
		values[1] = CStringGetTextDatum(entry->query_text);
		values[2] = Int32GetDatum(entry->num_tables);
		values[3] = TimestampTzGetDatum(entry->subscribed_at);
		values[4] = Int64GetDatum(entry->invalidation_count);

		tuple = heap_form_tuple(funcctx->tuple_desc, values, nulls);
		SRF_RETURN_NEXT(funcctx, HeapTupleGetDatum(tuple));
	}
	else
	{
		LWLockRelease(pgr_state->lock);
		SRF_RETURN_DONE(funcctx);
	}
}

/*
 * SQL function: pgr.stats() -> SETOF record(metric text, value text)
 */
PG_FUNCTION_INFO_V1(pgr_stats);
Datum
pgr_stats(PG_FUNCTION_ARGS)
{
	FuncCallContext *funcctx;

	if (SRF_IS_FIRSTCALL())
	{
		MemoryContext oldcontext;
		TupleDesc	tupdesc;

		funcctx = SRF_FIRSTCALL_INIT();
		oldcontext = MemoryContextSwitchTo(funcctx->multi_call_memory_ctx);

		tupdesc = CreateTemplateTupleDesc(2);
		TupleDescInitEntry(tupdesc, (AttrNumber) 1, "metric",
						   TEXTOID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 2, "value",
						   TEXTOID, -1, 0);
		funcctx->tuple_desc = BlessTupleDesc(tupdesc);
		funcctx->max_calls = 5;
		funcctx->call_cntr = 0;

		MemoryContextSwitchTo(oldcontext);
	}

	funcctx = SRF_PERCALL_SETUP();

	if (funcctx->call_cntr < funcctx->max_calls)
	{
		Datum		values[2];
		bool		nulls[2];
		HeapTuple	tuple;
		char		valbuf[64];

		memset(nulls, 0, sizeof(nulls));

		LWLockAcquire(pgr_state->lock, LW_SHARED);

		switch (funcctx->call_cntr)
		{
			case 0:
				values[0] = CStringGetTextDatum("active_subscriptions");
				snprintf(valbuf, sizeof(valbuf), "%ld",
						 hash_get_num_entries(pgr_dep_hash));
				break;
			case 1:
				values[0] = CStringGetTextDatum("max_subscriptions");
				snprintf(valbuf, sizeof(valbuf), "%d",
						 pgr_max_subscriptions);
				break;
			case 2:
				values[0] = CStringGetTextDatum("total_subscribes");
				snprintf(valbuf, sizeof(valbuf), "%ld",
						 pgr_state->subscribe_count);
				break;
			case 3:
				values[0] = CStringGetTextDatum("total_unsubscribes");
				snprintf(valbuf, sizeof(valbuf), "%ld",
						 pgr_state->unsubscribe_count);
				break;
			case 4:
				values[0] = CStringGetTextDatum("total_invalidations");
				snprintf(valbuf, sizeof(valbuf), "%ld",
						 pgr_state->invalidation_count);
				break;
			default:
				LWLockRelease(pgr_state->lock);
				SRF_RETURN_DONE(funcctx);
		}

		LWLockRelease(pgr_state->lock);

		values[1] = CStringGetTextDatum(valbuf);
		tuple = heap_form_tuple(funcctx->tuple_desc, values, nulls);
		SRF_RETURN_NEXT(funcctx, HeapTupleGetDatum(tuple));
	}

	SRF_RETURN_DONE(funcctx);
}

/*
 * Module initialization.
 */
void
_PG_init(void)
{
	if (!process_shared_preload_libraries_in_progress)
		return;

	/* GUC: pg_reactive.max_subscriptions */
	DefineCustomIntVariable("pg_reactive.max_subscriptions",
							"Maximum number of live query subscriptions",
							NULL,
							&pgr_max_subscriptions,
							1024,		/* default */
							1,			/* min */
							65536,		/* max */
							PGC_POSTMASTER,
							0,
							NULL, NULL, NULL);

	/* GUC: pg_reactive.async_recompute */
	DefineCustomBoolVariable("pg_reactive.async_recompute",
							 "Enable async recompute via background worker",
							 "When enabled, DML triggers defer recompute to a "
							 "background worker instead of running inline.",
							 &pgr_async_recompute,
							 false,		/* default off */
							 PGC_POSTMASTER,
							 0,
							 NULL, NULL, NULL);

	/* GUC: pg_reactive.database */
	DefineCustomStringVariable("pg_reactive.database",
							   "Database for the background worker to connect to",
							   NULL,
							   &pgr_database,
							   "postgres",	/* default */
							   PGC_POSTMASTER,
							   0,
							   NULL, NULL, NULL);

	/* Install shared memory hooks */
	pgr_dep_init_hooks();

	/* Install invalidation hooks (ProcessUtility + xact callback) */
	pgr_invalidation_init_hooks();

	/* Install recompute hooks (pre-commit callback) */
	pgr_recompute_init_hooks();

	/* Register background worker for async recompute (only if enabled) */
	if (pgr_async_recompute)
		pgr_bgworker_register();

	elog(LOG, "pg_reactive %s: loaded (max_subscriptions=%d, async_recompute=%s)",
		 PG_REACTIVE_VERSION, pgr_max_subscriptions,
		 pgr_async_recompute ? "on" : "off");
}
