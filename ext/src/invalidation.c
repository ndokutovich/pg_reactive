#include "postgres.h"

#include "access/xact.h"
#include "utils/memutils.h"
#include "utils/snapmgr.h"
#include "catalog/namespace.h"
#include "catalog/pg_trigger.h"
#include "commands/trigger.h"
#include "executor/spi.h"
#include "nodes/nodes.h"
#include "nodes/parsenodes.h"
#include "tcop/utility.h"
#include "utils/builtins.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"

#include "pg_reactive.h"
#include "invalidation.h"
#include "recompute.h"

/* ProcessUtility hook chain */
static ProcessUtility_hook_type prev_ProcessUtility = NULL;

/*
 * Per-transaction dirty list. Tracks query_ids that need recompute.
 * Allocated in TopTransactionContext, freed automatically on xact end.
 */
typedef struct PgrDirtyList
{
	int		count;
	char	query_ids[PGR_MAX_DIRTY][PGR_QUERY_ID_LEN];
} PgrDirtyList;

static PgrDirtyList *dirty_list = NULL;

static void pgr_ensure_dirty_list(void);
static void pgr_xact_callback(XactEvent event, void *arg);

/*
 * Ensure the dirty list exists for the current transaction.
 */
static void
pgr_ensure_dirty_list(void)
{
	if (dirty_list == NULL)
	{
		MemoryContext old = MemoryContextSwitchTo(TopTransactionContext);
		dirty_list = palloc0(sizeof(PgrDirtyList));
		MemoryContextSwitchTo(old);
	}
}

/*
 * Add a query_id to the dirty list if not already present.
 */
static void
pgr_mark_dirty(const char *query_id)
{
	int		i;

	pgr_ensure_dirty_list();

	/* Deduplicate */
	for (i = 0; i < dirty_list->count; i++)
	{
		if (strcmp(dirty_list->query_ids[i], query_id) == 0)
			return;
	}

	if (dirty_list->count < PGR_MAX_DIRTY)
	{
		strlcpy(dirty_list->query_ids[dirty_list->count],
				query_id, PGR_QUERY_ID_LEN);
		dirty_list->count++;
	}
	else
	{
		elog(WARNING, "pg_reactive: dirty list overflow (max %d), some queries may not be refreshed",
			 PGR_MAX_DIRTY);
	}
}

/*
 * Mark all queries that depend on a given table as dirty.
 */
void
pgr_invalidate_table(Oid table_oid)
{
	char	query_ids[256][PGR_QUERY_ID_LEN];
	int		count;
	int		i;

	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	count = pgr_dep_find_by_table(table_oid, query_ids, 256);

	for (i = 0; i < count; i++)
		pgr_mark_dirty(query_ids[i]);

	/* Update shared stats */
	if (count > 0)
	{
		LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
		pgr_state->invalidation_count += count;
		LWLockRelease(pgr_state->lock);
	}
}

/*
 * Get the current dirty list. Returns count.
 */
int
pgr_get_dirty_queries(char query_ids[][PGR_QUERY_ID_LEN], int max_results)
{
	int		count;
	int		i;

	if (dirty_list == NULL)
		return 0;

	count = Min(dirty_list->count, max_results);
	for (i = 0; i < count; i++)
		strlcpy(query_ids[i], dirty_list->query_ids[i], PGR_QUERY_ID_LEN);

	return count;
}

/*
 * Clear the dirty list.
 */
void
pgr_clear_dirty(void)
{
	if (dirty_list != NULL)
	{
		dirty_list->count = 0;
		dirty_list = NULL;		/* will be freed with TopTransactionContext */
	}
}

/*
 * C trigger function: installed on tracked tables as AFTER INSERT/UPDATE/DELETE
 * FOR EACH STATEMENT. Looks up which queries depend on the modified table and
 * marks them dirty.
 */
PG_FUNCTION_INFO_V1(pgr_trigger_func);
Datum
pgr_trigger_func(PG_FUNCTION_ARGS)
{
	TriggerData *trigdata = (TriggerData *) fcinfo->context;
	Oid			table_oid;

	if (!CALLED_AS_TRIGGER(fcinfo))
		elog(ERROR, "pgr_trigger_func: not called as trigger");

	table_oid = RelationGetRelid(trigdata->tg_relation);

	/* Update invalidation stats */
	pgr_invalidate_table(table_oid);

	/* Recompute affected queries, diff against snapshot, send NOTIFY.
	 * SPI_connect pushes a snapshot that predates the triggering DML.
	 * We pop it, advance the command counter, and push a fresh snapshot
	 * so SPI queries can see the DML's effects. */
	SPI_connect();
	PopActiveSnapshot();
	CommandCounterIncrement();
	PushActiveSnapshot(GetTransactionSnapshot());
	pgr_recompute_for_table(table_oid);
	SPI_finish();

	return PointerGetDatum(NULL);
}

/*
 * Install AFTER statement-level triggers on a table.
 * Creates three triggers: INSERT, UPDATE, DELETE.
 */
void
pgr_install_triggers(Oid table_oid)
{
	char	   *relname;
	char	   *nspname;
	StringInfoData buf;
	int			ret;

	relname = get_rel_name(table_oid);
	nspname = get_namespace_name(get_rel_namespace(table_oid));

	if (relname == NULL || nspname == NULL)
		ereport(ERROR,
				(errcode(ERRCODE_UNDEFINED_TABLE),
				 errmsg("pg_reactive: table OID %u not found", table_oid)));

	/* Allocate buffer before SPI_connect so it survives SPI_finish(). */
	initStringInfo(&buf);

	SPI_connect();

	/* INSERT trigger */
	appendStringInfo(&buf,
		"CREATE TRIGGER pgr_ins_%u "
		"AFTER INSERT ON %s.%s "
		"FOR EACH STATEMENT "
		"EXECUTE FUNCTION pgr.trigger_func()",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));

	ret = SPI_execute(buf.data, false, 0);
	if (ret != SPI_OK_UTILITY)
		elog(WARNING, "pg_reactive: failed to install INSERT trigger on %s.%s",
			 nspname, relname);

	/* UPDATE trigger */
	resetStringInfo(&buf);
	appendStringInfo(&buf,
		"CREATE TRIGGER pgr_upd_%u "
		"AFTER UPDATE ON %s.%s "
		"FOR EACH STATEMENT "
		"EXECUTE FUNCTION pgr.trigger_func()",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));

	ret = SPI_execute(buf.data, false, 0);
	if (ret != SPI_OK_UTILITY)
		elog(WARNING, "pg_reactive: failed to install UPDATE trigger on %s.%s",
			 nspname, relname);

	/* DELETE trigger */
	resetStringInfo(&buf);
	appendStringInfo(&buf,
		"CREATE TRIGGER pgr_del_%u "
		"AFTER DELETE ON %s.%s "
		"FOR EACH STATEMENT "
		"EXECUTE FUNCTION pgr.trigger_func()",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));

	ret = SPI_execute(buf.data, false, 0);
	if (ret != SPI_OK_UTILITY)
		elog(WARNING, "pg_reactive: failed to install DELETE trigger on %s.%s",
			 nspname, relname);

	SPI_finish();
	pfree(buf.data);

	elog(DEBUG1, "pg_reactive: installed triggers on %s.%s (OID %u)",
		 nspname, relname, table_oid);
}

/*
 * Remove pg_reactive triggers from a table.
 */
void
pgr_remove_triggers(Oid table_oid)
{
	char	   *relname;
	char	   *nspname;
	StringInfoData buf;

	relname = get_rel_name(table_oid);
	nspname = get_namespace_name(get_rel_namespace(table_oid));

	if (relname == NULL || nspname == NULL)
		return;		/* table may have been dropped */

	/* Allocate buffer before SPI_connect so it survives SPI_finish(). */
	initStringInfo(&buf);

	SPI_connect();

	appendStringInfo(&buf,
		"DROP TRIGGER IF EXISTS pgr_ins_%u ON %s.%s",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));
	SPI_execute(buf.data, false, 0);

	resetStringInfo(&buf);
	appendStringInfo(&buf,
		"DROP TRIGGER IF EXISTS pgr_upd_%u ON %s.%s",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));
	SPI_execute(buf.data, false, 0);

	resetStringInfo(&buf);
	appendStringInfo(&buf,
		"DROP TRIGGER IF EXISTS pgr_del_%u ON %s.%s",
		table_oid,
		quote_identifier(nspname),
		quote_identifier(relname));
	SPI_execute(buf.data, false, 0);

	SPI_finish();
	pfree(buf.data);

	elog(DEBUG1, "pg_reactive: removed triggers from %s.%s (OID %u)",
		 nspname, relname, table_oid);
}

/*
 * Check if a table already has pg_reactive triggers.
 */
bool
pgr_has_triggers(Oid table_oid)
{
	StringInfoData buf;
	int			ret;
	bool		has;

	/* Allocate buffer before SPI_connect so it survives SPI_finish(). */
	initStringInfo(&buf);
	appendStringInfo(&buf,
		"SELECT 1 FROM pg_trigger WHERE tgrelid = %u "
		"AND tgname LIKE 'pgr_ins_%%' LIMIT 1",
		table_oid);

	SPI_connect();

	ret = SPI_execute(buf.data, true, 1);
	has = (ret == SPI_OK_SELECT && SPI_processed > 0);

	SPI_finish();
	pfree(buf.data);

	return has;
}

/*
 * ProcessUtility hook: intercept DDL on tracked tables.
 */
static void
pgr_ProcessUtility(PlannedStmt *pstmt,
				   const char *queryString,
				   bool readOnlyTree,
				   ProcessUtilityContext context,
				   ParamListInfo params,
				   QueryEnvironment *queryEnv,
				   DestReceiver *dest,
				   QueryCompletion *qc)
{
	Node	   *parsetree = pstmt->utilityStmt;

	/* Execute the DDL first (so the action happens), then invalidate */
	if (prev_ProcessUtility)
		prev_ProcessUtility(pstmt, queryString, readOnlyTree,
							context, params, queryEnv, dest, qc);
	else
		standard_ProcessUtility(pstmt, queryString, readOnlyTree,
								context, params, queryEnv, dest, qc);

	/* Now check if the DDL affected any tracked tables */
	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	switch (nodeTag(parsetree))
	{
		case T_TruncateStmt:
			{
				TruncateStmt *stmt = (TruncateStmt *) parsetree;
				ListCell   *lc;

				foreach(lc, stmt->relations)
				{
					RangeVar   *rv = lfirst_node(RangeVar, lc);
					Oid			relid = RangeVarGetRelid(rv, NoLock, true);

					if (OidIsValid(relid))
						pgr_invalidate_table(relid);
				}
			}
			break;

		case T_DropStmt:
			{
				DropStmt   *stmt = (DropStmt *) parsetree;

				if (stmt->removeType == OBJECT_TABLE)
				{
					ListCell   *lc;

					foreach(lc, stmt->objects)
					{
						List	   *names = lfirst_node(List, lc);
						RangeVar   *rv = makeRangeVarFromNameList(names);
						Oid			relid = RangeVarGetRelid(rv, NoLock, true);

						if (OidIsValid(relid))
							pgr_invalidate_table(relid);
					}
				}
			}
			break;

		default:
			break;
	}
}

/*
 * Transaction callback: clear dirty list on commit or abort.
 * (In Phase 4, pre-commit will trigger recompute before clearing.)
 */
static void
pgr_xact_callback(XactEvent event, void *arg)
{
	switch (event)
	{
		case XACT_EVENT_COMMIT:
		case XACT_EVENT_ABORT:
			pgr_clear_dirty();
			break;
		default:
			break;
	}
}

/*
 * Initialize hooks for invalidation.
 */
void
pgr_invalidation_init_hooks(void)
{
	prev_ProcessUtility = ProcessUtility_hook;
	ProcessUtility_hook = pgr_ProcessUtility;

	RegisterXactCallback(pgr_xact_callback, NULL);
}
