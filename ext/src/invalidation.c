#include "postgres.h"

#include "access/relation.h"
#include "access/xact.h"
#include "utils/memutils.h"
#include "utils/snapmgr.h"
#include "catalog/namespace.h"
#include "catalog/pg_trigger.h"
#include "commands/async.h"
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
#include "bgworker.h"

/* ProcessUtility hook chain */
static ProcessUtility_hook_type prev_ProcessUtility = NULL;

/*
 * Per-transaction dirty list. Tracks query_ids that need recompute.
 * Allocated in TopTransactionContext, freed automatically on xact end.
 * Grows dynamically — no fixed upper limit.
 */
typedef struct PgrDirtyList
{
	int		count;
	int		capacity;
	char	(*query_ids)[PGR_QUERY_ID_LEN];	/* palloc'd array */
} PgrDirtyList;

/*
 * Per-transaction dirty table list. Tracks table OIDs for async queue push.
 * Allocated in TopTransactionContext, freed automatically on xact end.
 */
#define PGR_MAX_DIRTY_TABLES 256

typedef struct PgrDirtyTableList
{
	int		count;
	Oid		table_oids[PGR_MAX_DIRTY_TABLES];
} PgrDirtyTableList;

static PgrDirtyList *dirty_list = NULL;
static PgrDirtyTableList *dirty_tables = NULL;

static void pgr_ensure_dirty_list(void);
static void pgr_ensure_dirty_tables(void);
static void pgr_mark_dirty_table(Oid table_oid);
static void pgr_xact_callback(XactEvent event, void *arg);
static char *pgr_sanitize_trigger_id(const char *query_id);

/*
 * Sanitize a query_id for use in SQL trigger names.
 * Replaces any non-alphanumeric, non-underscore character with '_'.
 * Returns a palloc'd string.
 */
static char *
pgr_sanitize_trigger_id(const char *query_id)
{
	char   *result;
	int		i;

	result = pstrdup(query_id);
	for (i = 0; result[i] != '\0'; i++)
	{
		char c = result[i];
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			  (c >= '0' && c <= '9') || c == '_'))
			result[i] = '_';
	}
	return result;
}

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
		dirty_list->capacity = PGR_MAX_DIRTY;
		dirty_list->query_ids = palloc(dirty_list->capacity * PGR_QUERY_ID_LEN);

		MemoryContextSwitchTo(old);
	}
}

/*
 * Add a query_id to the dirty list if not already present.
 * Grows dynamically if needed.
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

	/* Grow if needed */
	if (dirty_list->count >= dirty_list->capacity)
	{
		MemoryContext old = MemoryContextSwitchTo(TopTransactionContext);

		dirty_list->capacity *= 2;
		dirty_list->query_ids = repalloc(dirty_list->query_ids,
										 dirty_list->capacity * PGR_QUERY_ID_LEN);

		MemoryContextSwitchTo(old);
	}

	strlcpy(dirty_list->query_ids[dirty_list->count],
			query_id, PGR_QUERY_ID_LEN);
	dirty_list->count++;
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
 * Ensure the dirty table list exists for the current transaction.
 */
static void
pgr_ensure_dirty_tables(void)
{
	if (dirty_tables == NULL)
	{
		MemoryContext old = MemoryContextSwitchTo(TopTransactionContext);
		dirty_tables = palloc0(sizeof(PgrDirtyTableList));
		MemoryContextSwitchTo(old);
	}
}

/*
 * Track a table OID as dirty for async queue push on COMMIT.
 */
static void
pgr_mark_dirty_table(Oid table_oid)
{
	int		i;

	pgr_ensure_dirty_tables();

	/* Deduplicate */
	for (i = 0; i < dirty_tables->count; i++)
	{
		if (dirty_tables->table_oids[i] == table_oid)
			return;
	}

	if (dirty_tables->count < PGR_MAX_DIRTY_TABLES)
		dirty_tables->table_oids[dirty_tables->count++] = table_oid;
}

/*
 * Clear the dirty list and dirty table list.
 */
void
pgr_clear_dirty(void)
{
	if (dirty_list != NULL)
	{
		dirty_list->count = 0;
		dirty_list = NULL;		/* will be freed with TopTransactionContext */
	}
	if (dirty_tables != NULL)
	{
		dirty_tables->count = 0;
		dirty_tables = NULL;	/* will be freed with TopTransactionContext */
	}
}

/*
 * C trigger function: installed on tracked tables as AFTER INSERT/UPDATE/DELETE
 * FOR EACH STATEMENT. Looks up which queries depend on the modified table and
 * marks them dirty.
 *
 * Per-query UPDATE triggers pass query_id as first argument to avoid
 * double-counting when multiple per-query triggers fire on the same table.
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

	if (trigdata->tg_trigger->tgnargs > 0)
	{
		/* Per-query UPDATE trigger: only invalidate the specific query */
		const char *query_id = trigdata->tg_trigger->tgargs[0];

		pgr_mark_dirty(query_id);

		/* Update shared stats */
		LWLockAcquire(pgr_state->lock, LW_EXCLUSIVE);
		pgr_state->invalidation_count++;
		LWLockRelease(pgr_state->lock);
	}
	else
	{
		/* Base INSERT/DELETE trigger: invalidate all queries for this table */
		pgr_invalidate_table(table_oid);
	}

	if (pgr_async_recompute)
	{
		/* Async mode: just track the dirty table OID.
		 * The xact callback will push it to the shared queue on COMMIT,
		 * and the background worker will handle recompute. */
		pgr_mark_dirty_table(table_oid);
	}
	else
	{
		/* Sync mode: recompute inline within the trigger.
		 * SPI_connect pushes a snapshot that predates the triggering DML.
		 * We pop it, advance the command counter, and push a fresh snapshot
		 * so SPI queries can see the DML's effects. */
		SPI_connect();
		PopActiveSnapshot();
		CommandCounterIncrement();
		PushActiveSnapshot(GetTransactionSnapshot());
		pgr_recompute_for_table(table_oid);
		SPI_finish();
	}

	return PointerGetDatum(NULL);
}

/*
 * Install base AFTER statement-level triggers on a table.
 * Creates two triggers: INSERT, DELETE.
 * UPDATE triggers are per-query (with column lists) and installed separately.
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
 * Install a per-query UPDATE trigger with AFTER UPDATE OF <columns>.
 * If col_mask == PGR_COL_MASK_ALL or 0, creates AFTER UPDATE (all columns).
 * Trigger name: pgr_upd_<tableoid>_<queryid>
 */
void
pgr_install_update_trigger(Oid table_oid, const char *query_id,
						   uint64 col_mask)
{
	char	   *relname;
	char	   *nspname;
	char	   *safe_id;
	StringInfoData buf;
	int			ret;

	relname = get_rel_name(table_oid);
	nspname = get_namespace_name(get_rel_namespace(table_oid));

	if (relname == NULL || nspname == NULL)
		ereport(ERROR,
				(errcode(ERRCODE_UNDEFINED_TABLE),
				 errmsg("pg_reactive: table OID %u not found", table_oid)));

	safe_id = pgr_sanitize_trigger_id(query_id);

	/* Allocate buffer before SPI_connect so it survives SPI_finish(). */
	initStringInfo(&buf);

	if (col_mask == PGR_COL_MASK_ALL || col_mask == 0)
	{
		/* All columns — plain AFTER UPDATE */
		appendStringInfo(&buf,
			"CREATE TRIGGER pgr_upd_%u_%s "
			"AFTER UPDATE ON %s.%s "
			"FOR EACH STATEMENT "
			"EXECUTE FUNCTION pgr.trigger_func(%s)",
			table_oid, safe_id,
			quote_identifier(nspname),
			quote_identifier(relname),
			quote_literal_cstr(query_id));
	}
	else
	{
		/* Column-specific: AFTER UPDATE OF col1, col2, ... */
		Relation	rel;
		TupleDesc	tupdesc;
		StringInfoData collist;
		bool		first = true;
		int			j;

		rel = relation_open(table_oid, AccessShareLock);
		tupdesc = RelationGetDescr(rel);

		initStringInfo(&collist);

		for (j = 0; j < tupdesc->natts; j++)
		{
			Form_pg_attribute att = TupleDescAttr(tupdesc, j);

			if (att->attisdropped)
				continue;

			/* Check if this column's bit is set (bit 0 = attnum 1) */
			if (att->attnum <= 64 &&
				(col_mask & ((uint64) 1 << (att->attnum - 1))) != 0)
			{
				if (!first)
					appendStringInfoString(&collist, ", ");
				appendStringInfoString(&collist,
									   quote_identifier(NameStr(att->attname)));
				first = false;
			}
		}

		relation_close(rel, AccessShareLock);

		if (first)
		{
			/* No columns matched — fall back to all columns */
			appendStringInfo(&buf,
				"CREATE TRIGGER pgr_upd_%u_%s "
				"AFTER UPDATE ON %s.%s "
				"FOR EACH STATEMENT "
				"EXECUTE FUNCTION pgr.trigger_func(%s)",
				table_oid, safe_id,
				quote_identifier(nspname),
				quote_identifier(relname),
				quote_literal_cstr(query_id));
		}
		else
		{
			appendStringInfo(&buf,
				"CREATE TRIGGER pgr_upd_%u_%s "
				"AFTER UPDATE OF %s ON %s.%s "
				"FOR EACH STATEMENT "
				"EXECUTE FUNCTION pgr.trigger_func(%s)",
				table_oid, safe_id,
				collist.data,
				quote_identifier(nspname),
				quote_identifier(relname),
				quote_literal_cstr(query_id));
		}

		pfree(collist.data);
	}

	SPI_connect();

	ret = SPI_execute(buf.data, false, 0);
	if (ret != SPI_OK_UTILITY)
		elog(WARNING, "pg_reactive: failed to install UPDATE trigger pgr_upd_%u_%s on %s.%s",
			 table_oid, safe_id, nspname, relname);

	SPI_finish();
	pfree(buf.data);
	pfree(safe_id);

	elog(DEBUG1, "pg_reactive: installed UPDATE trigger on %s.%s for query %s",
		 nspname, relname, query_id);
}

/*
 * Remove a per-query UPDATE trigger.
 */
void
pgr_remove_update_trigger(Oid table_oid, const char *query_id)
{
	char	   *relname;
	char	   *nspname;
	char	   *safe_id;
	StringInfoData buf;

	relname = get_rel_name(table_oid);
	nspname = get_namespace_name(get_rel_namespace(table_oid));

	if (relname == NULL || nspname == NULL)
		return;		/* table may have been dropped */

	safe_id = pgr_sanitize_trigger_id(query_id);

	/* Allocate buffer before SPI_connect so it survives SPI_finish(). */
	initStringInfo(&buf);

	appendStringInfo(&buf,
		"DROP TRIGGER IF EXISTS pgr_upd_%u_%s ON %s.%s",
		table_oid, safe_id,
		quote_identifier(nspname),
		quote_identifier(relname));

	SPI_connect();
	SPI_execute("SET LOCAL client_min_messages TO warning", false, 0);
	SPI_execute(buf.data, false, 0);
	SPI_finish();
	pfree(buf.data);
	pfree(safe_id);

	elog(DEBUG1, "pg_reactive: removed UPDATE trigger for query %s from %s.%s",
		 query_id, nspname, relname);
}

/*
 * Remove base pg_reactive triggers (INSERT/DELETE) from a table.
 * Per-query UPDATE triggers are removed separately via pgr_remove_update_trigger().
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
 * Emit a schema_changed NOTIFY for all subscriptions referencing a table.
 * Used when DROP COLUMN or RENAME COLUMN is detected on a tracked table.
 * The notification tells connected clients to re-subscribe with the new schema.
 * After notifying, each affected subscription is unsubscribed automatically.
 *
 * Must be called BEFORE the DDL executes so that catalog lookups still work.
 */
static void
pgr_notify_schema_changed_and_unsubscribe(Oid table_oid, const char *table_name)
{
	char		query_ids[256][PGR_QUERY_ID_LEN];
	int			count;
	int			i;

	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	count = pgr_dep_find_by_table(table_oid, query_ids, 256);
	if (count == 0)
		return;

	for (i = 0; i < count; i++)
	{
		StringInfoData payload;

		/* Emit schema_changed notification on the configured channel */
		initStringInfo(&payload);
		appendStringInfoString(&payload, "{\"type\":\"schema_changed\",\"query_id\":");
		pgr_json_escape_string(&payload, query_ids[i]);
		appendStringInfoString(&payload, ",\"table\":");
		pgr_json_escape_string(&payload, table_name);
		appendStringInfoChar(&payload, '}');

		Async_Notify(pgr_notify_channel, payload.data);
		pfree(payload.data);

		elog(DEBUG1,
			 "pg_reactive: schema_changed emitted for query %s on table %s",
			 query_ids[i], table_name);
	}

	/*
	 * Unsubscribe all affected queries — their snapshots and triggers are
	 * now stale due to the column structure change.
	 * Pass NULL for reason to suppress a redundant WARNING; the schema_changed
	 * NOTIFY above already informs clients to re-subscribe.
	 */
	pgr_unsubscribe_all_for_table(table_oid, NULL);
}

/*
 * ProcessUtility hook: intercept DDL on tracked tables.
 *
 * Execution order matters:
 *   - DROP TABLE: resolve OIDs and clean up BEFORE DDL executes (catalog
 *     entries disappear after DROP).
 *   - DROP COLUMN / RENAME COLUMN: notify and unsubscribe BEFORE DDL (same
 *     reason — column metadata needs to be readable).
 *   - TRUNCATE / general ALTER / RENAME TABLE: invalidate AFTER DDL.
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

	/* Guard: skip if extension shmem not yet initialised */
	if (pgr_state == NULL || pgr_dep_hash == NULL)
		goto run_ddl;

	/*
	 * PRE-DDL phase: handle operations where we need the catalog intact.
	 *
	 * DROP TABLE — resolve table OIDs and auto-unsubscribe tracked queries
	 * before the table disappears from the catalog.
	 *
	 * ALTER TABLE DROP COLUMN / RENAME COLUMN — emit schema_changed NOTIFY
	 * and unsubscribe before the column metadata is gone.
	 */
	switch (nodeTag(parsetree))
	{
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
						{
							char   *tname = get_rel_name(relid);
							char	reason[320];

							if (tname != NULL)
								snprintf(reason, sizeof(reason),
										 "DROP TABLE on %s", tname);
							else
								snprintf(reason, sizeof(reason),
										 "DROP TABLE on OID %u", relid);

							pgr_unsubscribe_all_for_table(relid, reason);
						}
					}
				}
			}
			break;

		case T_AlterTableStmt:
			{
				/*
				 * ALTER TABLE DROP COLUMN is handled here (pre-DDL) because
				 * column metadata disappears after the DDL executes.
				 *
				 * Note: In PostgreSQL, RENAME COLUMN goes through RenameStmt
				 * (renameType == OBJECT_COLUMN), NOT through AlterTableStmt.
				 * So we only need to check AT_DropColumn here.
				 */
				AlterTableStmt *stmt = (AlterTableStmt *) parsetree;
				ListCell	   *lc;
				bool			is_drop_column = false;

				foreach(lc, stmt->cmds)
				{
					AlterTableCmd *cmd = lfirst_node(AlterTableCmd, lc);

					if (cmd->subtype == AT_DropColumn)
					{
						is_drop_column = true;
						break;
					}
				}

				if (is_drop_column)
				{
					Oid		relid = RangeVarGetRelid(stmt->relation,
													  NoLock, true);

					if (OidIsValid(relid))
					{
						char	   *relname = get_rel_name(relid);
						char		table_name[256];

						if (relname != NULL)
							strlcpy(table_name, relname, sizeof(table_name));
						else
							snprintf(table_name, sizeof(table_name),
									 "OID %u", relid);

						pgr_notify_schema_changed_and_unsubscribe(relid,
																   table_name);
					}
				}
			}
			break;

		case T_RenameStmt:
			{
				RenameStmt *stmt = (RenameStmt *) parsetree;

				/*
				 * RENAME COLUMN: treat as schema change — emit notification
				 * and unsubscribe BEFORE the rename so column names in the
				 * subscription's query text still match the old schema.
				 */
				if (stmt->relation != NULL &&
					stmt->renameType == OBJECT_COLUMN)
				{
					Oid		relid = RangeVarGetRelid(stmt->relation,
													  NoLock, true);

					if (OidIsValid(relid))
					{
						char	   *relname = get_rel_name(relid);
						char		table_name[256];

						if (relname != NULL)
							strlcpy(table_name, relname, sizeof(table_name));
						else
							snprintf(table_name, sizeof(table_name),
									 "OID %u", relid);

						pgr_notify_schema_changed_and_unsubscribe(relid,
																   table_name);
					}
				}
			}
			break;

		default:
			break;
	}

run_ddl:
	/* Execute the DDL */
	if (prev_ProcessUtility)
		prev_ProcessUtility(pstmt, queryString, readOnlyTree,
							context, params, queryEnv, dest, qc);
	else
		standard_ProcessUtility(pstmt, queryString, readOnlyTree,
								context, params, queryEnv, dest, qc);

	/* Guard: skip post-DDL processing if not initialised */
	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	/*
	 * POST-DDL phase: handle operations where we act after the DDL executes.
	 *
	 * TRUNCATE — invalidate all tracked queries on the truncated tables.
	 *   Iterates all relations in stmt->relations to handle multi-table TRUNCATE.
	 *
	 * RENAME TABLE — invalidate queries (the table still exists, just renamed;
	 *   the query text is now stale but the OID is unchanged).
	 *
	 * General ALTER TABLE (non column-drop/rename) — invalidate as before.
	 *   Column-drop/rename was already handled in the pre-DDL phase above.
	 */
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

		case T_AlterTableStmt:
			{
				/*
				 * Only invalidate for ALTER operations that are NOT DROP COLUMN
				 * (those were already handled pre-DDL above with schema_changed).
				 * RENAME COLUMN goes through RenameStmt, not here.
				 */
				AlterTableStmt *stmt = (AlterTableStmt *) parsetree;
				ListCell	   *lc;
				bool			has_drop_column = false;

				foreach(lc, stmt->cmds)
				{
					AlterTableCmd *cmd = lfirst_node(AlterTableCmd, lc);

					if (cmd->subtype == AT_DropColumn)
					{
						has_drop_column = true;
						break;
					}
				}

				if (!has_drop_column)
				{
					Oid		relid = RangeVarGetRelid(stmt->relation,
													  NoLock, true);

					if (OidIsValid(relid))
						pgr_invalidate_table(relid);
				}
			}
			break;

		case T_RenameStmt:
			{
				RenameStmt *stmt = (RenameStmt *) parsetree;

				/*
				 * RENAME TABLE: the OID is unchanged, but the query text stored
				 * in shmem now references the old table name. Invalidate so
				 * clients know to re-subscribe with the new name.
				 * (Column rename was handled pre-DDL.)
				 */
				if (stmt->relation != NULL &&
					stmt->renameType == OBJECT_TABLE)
				{
					Oid		relid = RangeVarGetRelid(stmt->relation,
													  NoLock, true);

					if (OidIsValid(relid))
						pgr_invalidate_table(relid);
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
			/* In async mode, push dirty table OIDs to shared queue
			 * so the background worker can recompute after commit. */
			if (pgr_async_recompute && dirty_tables != NULL)
			{
				int		i;

				for (i = 0; i < dirty_tables->count; i++)
				{
					pgr_dirty_queue_push(dirty_tables->table_oids[i]);
				}

				/* Wake the background worker */
				if (dirty_tables->count > 0)
					pgr_signal_worker();
			}
			pgr_clear_dirty();
			break;
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
