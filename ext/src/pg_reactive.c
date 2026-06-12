#include "postgres.h"

#include "access/relation.h"
#include "catalog/namespace.h"
#include "catalog/pg_class.h"
#include "fmgr.h"
#include "funcapi.h"
#include "lib/stringinfo.h"
#include "miscadmin.h"
#include "parser/analyze.h"
#include "parser/parser.h"
#include "utils/builtins.h"
#include "utils/guc.h"
#include "utils/jsonb.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"

#include "pg_reactive.h"
#include "invalidation.h"
#include "recompute.h"
#include "bgworker.h"

PG_MODULE_MAGIC;

/* GUC variables */
int pgr_max_subscriptions = 1024;
char *pgr_notify_channel = "pgr";
bool pgr_batch_invalidation = true;

void _PG_init(void);

/* Forward declaration */
void pgr_unsubscribe_all_for_table(Oid table_oid, const char *reason);

/*
 * Context for recursive dependency extraction.
 * Collects table OIDs and per-table column bitmasks.
 */
typedef struct {
	Oid		   *table_oids;
	uint64	   *col_masks;		/* bitmask of AttrNumbers per table */
	int			count;
	int			max_tables;
	bool		has_star;		/* SELECT * detected */
} ExtractDepsContext;

static void pgr_extract_from_node(Node *node, ExtractDepsContext *ctx);
static void pgr_extract_from_select(SelectStmt *sel, ExtractDepsContext *ctx);
static void pgr_extract_columns_from_node(Node *node, ExtractDepsContext *ctx);

/*
 * Add a table OID to the context, deduplicating.
 * Returns the index of the table in the arrays.
 */
static int
pgr_add_table_oid(ExtractDepsContext *ctx, Oid relid)
{
	int		i;

	if (!OidIsValid(relid))
		return -1;

	/* Check if already present */
	for (i = 0; i < ctx->count; i++)
	{
		if (ctx->table_oids[i] == relid)
			return i;
	}

	if (ctx->count >= ctx->max_tables)
		return -1;

	ctx->table_oids[ctx->count] = relid;
	ctx->col_masks[ctx->count] = 0;
	return ctx->count++;
}

/*
 * Mark a column as referenced for a given table.
 * Looks up the table by name (schemaname.relname) among already-found tables
 * and sets the appropriate bit in col_masks.
 */
static void
pgr_mark_column(ExtractDepsContext *ctx, const char *schemaname,
				const char *relname, const char *colname)
{
	int		i;

	/*
	 * Walk all known tables and try to find one where the column name matches
	 * an actual attribute. If relname is given (qualified reference like t.col),
	 * only check tables that match the alias/name.
	 */
	for (i = 0; i < ctx->count; i++)
	{
		Relation	rel;
		TupleDesc	tupdesc;
		int			j;

		rel = relation_open(ctx->table_oids[i], NoLock);
		tupdesc = RelationGetDescr(rel);

		/* If qualified, check table name matches */
		if (relname != NULL)
		{
			const char *tname = RelationGetRelationName(rel);
			if (strcmp(tname, relname) != 0)
			{
				relation_close(rel, NoLock);
				continue;
			}
		}

		for (j = 0; j < tupdesc->natts; j++)
		{
			Form_pg_attribute att = TupleDescAttr(tupdesc, j);

			if (att->attisdropped)
				continue;

			if (strcmp(NameStr(att->attname), colname) == 0)
			{
				/* Set bit for this column (attnum is 1-based, bit 0 = attnum 1) */
				if (att->attnum <= 64)
					ctx->col_masks[i] |= ((uint64) 1 << (att->attnum - 1));
				relation_close(rel, NoLock);
				return;
			}
		}

		relation_close(rel, NoLock);
	}
}

/*
 * Extract column references from an expression node (ColumnRef).
 * Walks recursively through expressions looking for ColumnRef nodes.
 */
static void
pgr_extract_columns_from_node(Node *node, ExtractDepsContext *ctx)
{
	if (node == NULL)
		return;

	if (IsA(node, ColumnRef))
	{
		ColumnRef  *cref = (ColumnRef *) node;
		int			nfields = list_length(cref->fields);

		/* Check for SELECT * — first field is A_Star */
		if (nfields == 1)
		{
			Node *field = linitial(cref->fields);
			if (IsA(field, A_Star))
			{
				ctx->has_star = true;
				return;
			}
			/* Unqualified column: colname */
			pgr_mark_column(ctx, NULL, NULL, strVal(field));
		}
		else if (nfields == 2)
		{
			Node *first = linitial(cref->fields);
			Node *second = lsecond(cref->fields);

			if (IsA(second, A_Star))
			{
				/* table.* */
				ctx->has_star = true;
				return;
			}
			/* Qualified: table.column */
			pgr_mark_column(ctx, NULL, strVal(first), strVal(second));
		}
	}
	else if (IsA(node, A_Expr))
	{
		A_Expr *expr = (A_Expr *) node;
		pgr_extract_columns_from_node(expr->lexpr, ctx);
		pgr_extract_columns_from_node(expr->rexpr, ctx);
	}
	else if (IsA(node, BoolExpr))
	{
		BoolExpr   *bexpr = (BoolExpr *) node;
		ListCell   *lc;

		foreach(lc, bexpr->args)
			pgr_extract_columns_from_node(lfirst(lc), ctx);
	}
	else if (IsA(node, FuncCall))
	{
		FuncCall   *fc = (FuncCall *) node;
		ListCell   *lc;

		foreach(lc, fc->args)
			pgr_extract_columns_from_node(lfirst(lc), ctx);

		/* Check for agg_star (COUNT(*)) */
		if (fc->agg_star)
			ctx->has_star = true;
	}
	else if (IsA(node, ResTarget))
	{
		ResTarget  *rt = (ResTarget *) node;
		pgr_extract_columns_from_node(rt->val, ctx);
	}
	else if (IsA(node, SortBy))
	{
		SortBy	   *sb = (SortBy *) node;
		pgr_extract_columns_from_node(sb->node, ctx);
	}
	else if (IsA(node, TypeCast))
	{
		TypeCast   *tc = (TypeCast *) node;
		pgr_extract_columns_from_node(tc->arg, ctx);
	}
	else if (IsA(node, CoalesceExpr))
	{
		CoalesceExpr *ce = (CoalesceExpr *) node;
		ListCell   *lc;

		foreach(lc, ce->args)
			pgr_extract_columns_from_node(lfirst(lc), ctx);
	}
	else if (IsA(node, NullTest))
	{
		NullTest   *nt = (NullTest *) node;
		pgr_extract_columns_from_node((Node *) nt->arg, ctx);
	}
	else if (IsA(node, SubLink))
	{
		SubLink	   *sl = (SubLink *) node;
		pgr_extract_columns_from_node(sl->testexpr, ctx);
		/* Don't recurse into subquery — it has its own table context */
	}
	else if (IsA(node, CaseExpr))
	{
		CaseExpr   *ce = (CaseExpr *) node;
		ListCell   *lc;

		pgr_extract_columns_from_node((Node *) ce->arg, ctx);
		foreach(lc, ce->args)
		{
			CaseWhen *when = lfirst_node(CaseWhen, lc);
			pgr_extract_columns_from_node((Node *) when->expr, ctx);
			pgr_extract_columns_from_node((Node *) when->result, ctx);
		}
		pgr_extract_columns_from_node((Node *) ce->defresult, ctx);
	}
}

/*
 * Recursively walk a node looking for table references.
 */
static void
pgr_extract_from_node(Node *node, ExtractDepsContext *ctx)
{
	if (node == NULL)
		return;

	if (IsA(node, RangeVar))
	{
		RangeVar   *rv = (RangeVar *) node;
		Oid			relid = RangeVarGetRelid(rv, NoLock, true);

		pgr_add_table_oid(ctx, relid);
	}
	else if (IsA(node, JoinExpr))
	{
		JoinExpr   *j = (JoinExpr *) node;

		pgr_extract_from_node(j->larg, ctx);
		pgr_extract_from_node(j->rarg, ctx);
		/* Extract columns from JOIN ON clause */
		pgr_extract_columns_from_node(j->quals, ctx);
	}
	else if (IsA(node, RangeSubselect))
	{
		RangeSubselect *rs = (RangeSubselect *) node;

		if (rs->subquery && IsA(rs->subquery, SelectStmt))
			pgr_extract_from_select((SelectStmt *) rs->subquery, ctx);
	}
	else if (IsA(node, SubLink))
	{
		SubLink	   *sl = (SubLink *) node;

		if (sl->subselect && IsA(sl->subselect, SelectStmt))
			pgr_extract_from_select((SelectStmt *) sl->subselect, ctx);
	}
}

/*
 * Walk a SelectStmt recursively: FROM clause, target list, WHERE clause,
 * GROUP BY, HAVING, CTEs, and set operations.
 */
static void
pgr_extract_from_select(SelectStmt *sel, ExtractDepsContext *ctx)
{
	ListCell   *lc;

	if (sel == NULL)
		return;

	/* FROM clause — extract tables first */
	foreach(lc, sel->fromClause)
		pgr_extract_from_node(lfirst(lc), ctx);

	/* Target list (SELECT columns) */
	foreach(lc, sel->targetList)
		pgr_extract_columns_from_node(lfirst(lc), ctx);

	/* WHERE clause — may contain SubLink (subqueries) and ColumnRefs */
	if (sel->whereClause)
	{
		pgr_extract_from_node(sel->whereClause, ctx);
		pgr_extract_columns_from_node(sel->whereClause, ctx);
	}

	/* GROUP BY */
	foreach(lc, sel->groupClause)
		pgr_extract_columns_from_node(lfirst(lc), ctx);

	/* HAVING clause */
	if (sel->havingClause)
	{
		pgr_extract_from_node(sel->havingClause, ctx);
		pgr_extract_columns_from_node(sel->havingClause, ctx);
	}

	/* ORDER BY (sortClause) */
	foreach(lc, sel->sortClause)
		pgr_extract_columns_from_node(lfirst(lc), ctx);

	/* CTEs (WITH clause) */
	if (sel->withClause)
	{
		foreach(lc, sel->withClause->ctes)
		{
			CommonTableExpr *cte = lfirst_node(CommonTableExpr, lc);

			if (cte->ctequery && IsA(cte->ctequery, SelectStmt))
				pgr_extract_from_select((SelectStmt *) cte->ctequery, ctx);
		}
	}

	/* Set operations: UNION, EXCEPT, INTERSECT */
	if (sel->larg)
		pgr_extract_from_select(sel->larg, ctx);
	if (sel->rarg)
		pgr_extract_from_select(sel->rarg, ctx);
}

/*
 * Extract table OIDs and column bitmasks from a query by parsing it
 * and recursively walking the raw parse tree.
 *
 * If SELECT * or table.* is used, all tables get PGR_COL_MASK_ALL.
 */
static int
pgr_extract_deps(const char *query_text, Oid *table_oids,
				 uint64 *col_masks, int max_tables)
{
	List		   *raw_parsetree_list;
	ExtractDepsContext ctx;
	int				i;

	ctx.table_oids = table_oids;
	ctx.col_masks = col_masks;
	ctx.count = 0;
	ctx.max_tables = max_tables;
	ctx.has_star = false;

	raw_parsetree_list = raw_parser(query_text, RAW_PARSE_DEFAULT);

	/* C4: Validate that the query is a single SELECT statement */
	if (list_length(raw_parsetree_list) != 1)
		ereport(ERROR,
				(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
				 errmsg("subscribe: query must be a single SELECT statement")));

	{
		RawStmt	   *rawstmt = linitial_node(RawStmt, raw_parsetree_list);
		SelectStmt *sel;

		if (nodeTag(rawstmt->stmt) != T_SelectStmt)
			ereport(ERROR,
					(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
					 errmsg("subscribe: only SELECT queries are allowed")));

		sel = (SelectStmt *) rawstmt->stmt;

		/* Reject CTEs that contain DML (INSERT/UPDATE/DELETE) */
		if (sel->withClause)
		{
			ListCell   *cte_lc;

			foreach(cte_lc, sel->withClause->ctes)
			{
				CommonTableExpr *cte = lfirst_node(CommonTableExpr, cte_lc);

				if (cte->ctequery &&
					!IsA(cte->ctequery, SelectStmt))
					ereport(ERROR,
							(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
							 errmsg("subscribe: DML-capable CTEs are not allowed")));
			}
		}

		pgr_extract_from_select(sel, &ctx);
	}

	/* If SELECT * was used, mark all tables as all-columns */
	if (ctx.has_star)
	{
		for (i = 0; i < ctx.count; i++)
			ctx.col_masks[i] = PGR_COL_MASK_ALL;
	}

	return ctx.count;
}

/*
 * SQL function: pgr.subscribe(query_id text, query text, mode text DEFAULT 'delta') -> jsonb
 */
PG_FUNCTION_INFO_V1(pgr_subscribe);
Datum
pgr_subscribe(PG_FUNCTION_ARGS)
{
	text	   *query_id_text = PG_GETARG_TEXT_PP(0);
	text	   *query_text = PG_GETARG_TEXT_PP(1);
	char	   *query_id = text_to_cstring(query_id_text);
	char	   *query_str = text_to_cstring(query_text);
	char	   *mode_str;
	char		mode_char;
	char	   *audience_str = NULL;	/* serialised JSON, or NULL = no constraint */
	int64		generation = 0;		/* epoch from pgr.subscription_generation_seq */
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	uint64		col_masks[PGR_MAX_DEPS_PER_QUERY];
	int			num_tables;
	PgrEvictedInfo evicted;
	StringInfoData buf;

	/* Parse and validate mode parameter (default: 'delta') */
	if (PG_NARGS() >= 3 && !PG_ARGISNULL(2))
		mode_str = text_to_cstring(PG_GETARG_TEXT_PP(2));
	else
		mode_str = "delta";

	/*
	 * Parse audience parameter (jsonb, optional, default NULL).
	 * The proxy enforces this at WS-connect time: every key in audience must
	 * match the corresponding JWT claim. service_role JWTs always bypass.
	 * Stored as serialised JSON text to keep the shmem entry POD.
	 */
	if (PG_NARGS() >= 4 && !PG_ARGISNULL(3))
	{
		Jsonb	   *audience_jsonb = PG_GETARG_JSONB_P(3);
		Datum		audience_text;

		audience_text = DirectFunctionCall1(jsonb_out,
											JsonbPGetDatum(audience_jsonb));
		audience_str = DatumGetCString(audience_text);

		if (strlen(audience_str) >= PGR_AUDIENCE_LEN)
			ereport(ERROR,
					(errcode(ERRCODE_STRING_DATA_RIGHT_TRUNCATION),
					 errmsg("audience too long (%zu bytes, max %d)",
							strlen(audience_str), PGR_AUDIENCE_LEN - 1),
					 errhint("audience must be a small JSON object of claim predicates.")));
	}

	/*
	 * Parse generation (bigint, optional, default 0). The SQL pgr.subscribe
	 * wrapper draws it from pgr.subscription_generation_seq and passes it here
	 * so the shmem entry — and therefore every NOTIFY this query emits — carries
	 * the same epoch the catalog records. A 0 (legacy / restore-without-gen)
	 * means "unversioned"; the proxy treats it as generation 0.
	 */
	if (PG_NARGS() >= 5 && !PG_ARGISNULL(4))
		generation = PG_GETARG_INT64(4);

	if (strcmp(mode_str, "delta") == 0)
		mode_char = 'd';
	else if (strcmp(mode_str, "notify") == 0)
		mode_char = 'n';
	else
		ereport(ERROR,
				(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
				 errmsg("invalid mode \"%s\": must be 'delta' or 'notify'",
						mode_str)));

	/* Validate query_id length */
	if (strlen(query_id) >= PGR_QUERY_ID_LEN)
		ereport(ERROR,
				(errcode(ERRCODE_STRING_DATA_RIGHT_TRUNCATION),
				 errmsg("query_id too long (max %d characters)",
						PGR_QUERY_ID_LEN - 1)));

	/* Validate query_id contains only safe characters for SQL identifiers */
	if (!pgr_is_valid_query_id(query_id))
		ereport(ERROR,
				(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
				 errmsg("invalid query_id \"%s\": must contain only "
						"alphanumeric characters, underscores, and hyphens",
						query_id)));

	/* Validate query text length */
	if (strlen(query_str) >= PGR_QUERY_TEXT_LEN)
		ereport(ERROR,
				(errcode(ERRCODE_STRING_DATA_RIGHT_TRUNCATION),
				 errmsg("query text too long (%zu bytes, max %d)",
						strlen(query_str), PGR_QUERY_TEXT_LEN - 1),
				 errhint("Simplify the query or recompile with a larger PGR_QUERY_TEXT_LEN.")));

	/* Parse the query to extract table references and column bitmasks */
	num_tables = pgr_extract_deps(query_str, table_oids, col_masks,
								  PGR_MAX_DEPS_PER_QUERY);

	if (num_tables == 0)
		ereport(ERROR,
				(errcode(ERRCODE_INVALID_PARAMETER_VALUE),
				 errmsg("could not extract any table references from query")));

	/* Create snapshot table for delta mode — validates the query and fails
	 * early if the query is invalid (before we touch shared memory).
	 * Notify mode skips snapshot creation entirely.
	 *
	 * Drop first so a re-subscribe that repoints an existing query_id to a
	 * DIFFERENT query rebuilds the snapshot from the current query. Without the
	 * drop, pgr_snapshot_create's CREATE ... IF NOT EXISTS is a no-op and the
	 * snapshot keeps the OLD query's rows — which a fresh connection would then
	 * read via snapshotForGeneration. The generation matches (the re-subscribe
	 * bumped both the connection's bound gen and the snapshot's epoch), so the
	 * proxy gate cannot catch it: a tenant-B client would receive tenant-A's
	 * rows in its initial snapshot (round 39 batch-2 F-SNAP). The drop is a
	 * no-op on a first subscribe and rolls back with the transaction on abort;
	 * the generation model already disconnects every old connection on a
	 * re-subscribe, so nothing depends on the stale snapshot surviving. */
	if (mode_char == 'd')
	{
		pgr_snapshot_drop(query_id);
		pgr_snapshot_create(query_id, query_str);
	}

	/* Register in shared memory (only after snapshot succeeds).
	 * If shmem is full, pgr_dep_add evicts the oldest entry. */
	pgr_dep_add(query_id, query_str, table_oids, col_masks, num_tables,
				mode_char, audience_str, generation, &evicted);

	/* Clean up evicted subscription if one was evicted */
	if (evicted.evicted)
	{
		int		i;
		char	dummy[1][PGR_QUERY_ID_LEN];

		/* Drop the evicted subscription's snapshot table (delta mode only) */
		if (evicted.mode == 'd')
			pgr_snapshot_drop(evicted.query_id);

		/* Remove its per-query UPDATE triggers and clean up base triggers */
		for (i = 0; i < evicted.num_tables; i++)
		{
			int remaining;

			pgr_remove_update_trigger(evicted.table_oids[i],
									  evicted.query_id);
			remaining = pgr_dep_find_by_table(evicted.table_oids[i],
											  dummy, 1);
			if (remaining == 0)
				pgr_remove_triggers(evicted.table_oids[i]);
		}
	}

	/* Install triggers on any tables that don't have them yet.
	 * For UPDATE triggers, drop existing per-query trigger first (re-subscribe),
	 * then install per-query column-specific triggers. */
	{
		int		i;
		for (i = 0; i < num_tables; i++)
		{
			if (!pgr_has_triggers(table_oids[i]))
				pgr_install_triggers(table_oids[i]);
			/* Drop existing per-query trigger if re-subscribing */
			pgr_remove_update_trigger(table_oids[i], query_id);
			/* Install per-query UPDATE trigger with column list */
			pgr_install_update_trigger(table_oids[i], query_id,
									   col_masks[i]);
		}
	}

	/* Build JSON result */
	initStringInfo(&buf);
	appendStringInfoString(&buf, "{\"query_id\": ");
	pgr_json_escape_string(&buf, query_id);
	appendStringInfo(&buf,
					 ", \"tables\": %d, \"mode\": \"%s\", \"status\": \"subscribed\"}",
					 num_tables, mode_str);

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
	Oid			table_oids[PGR_MAX_DEPS_PER_QUERY];
	int			num_tables = 0;
	char		entry_mode = 'd';
	bool		found;

	/* Read mode under lock before removing (entry pointer is invalid after release) */
	{
		char		find_key[PGR_HASHKEY_LEN];
		PgrDepEntry *e;
		bool		found_e;

		pgr_dep_format_key(find_key, sizeof(find_key), query_id);
		LWLockAcquire(pgr_state->lock, LW_SHARED);
		e = (PgrDepEntry *) hash_search(pgr_dep_hash, find_key, HASH_FIND, &found_e);
		if (found_e && e != NULL)
			entry_mode = e->mode;
		LWLockRelease(pgr_state->lock);
	}

	num_tables = pgr_dep_copy_tables(query_id, table_oids,
									 PGR_MAX_DEPS_PER_QUERY);

	found = pgr_dep_remove(query_id);

	/* Drop the snapshot table (delta mode only — notify has no snapshot) */
	if (found && entry_mode == 'd')
		pgr_snapshot_drop(query_id);

	/* Remove per-query UPDATE triggers and check if base triggers can go */
	if (found)
	{
		int		i;
		char	dummy[1][PGR_QUERY_ID_LEN];

		for (i = 0; i < num_tables; i++)
		{
			int remaining;

			/* Remove the per-query UPDATE trigger */
			pgr_remove_update_trigger(table_oids[i], query_id);

			/* If no remaining subscriptions reference this table,
			 * remove the base INSERT/DELETE triggers too */
			remaining = pgr_dep_find_by_table(table_oids[i], dummy, 1);
			if (remaining == 0)
				pgr_remove_triggers(table_oids[i]);
		}
	}

	PG_RETURN_BOOL(found);
}

/*
 * Auto-unsubscribe all queries that reference a given table OID.
 *
 * Called from the ProcessUtility hook when:
 *   - DROP TABLE: before DDL so catalog lookups still work
 *   - DROP COLUMN / RENAME COLUMN: same reason (via pgr_notify_schema_changed_and_unsubscribe)
 *
 * For each affected query_id:
 *   - Remove shmem entry
 *   - Drop snapshot table (delta mode)
 *   - Remove per-query UPDATE trigger
 *   - Remove base INSERT/DELETE triggers if no remaining subscriptions
 *
 * The reason_context parameter appears in the WARNING message (e.g. "DROP TABLE on foo").
 * Pass NULL to suppress the WARNING.
 */
void
pgr_unsubscribe_all_for_table(Oid table_oid, const char *reason)
{
	char	query_ids[256][PGR_QUERY_ID_LEN];
	int		count;
	int		i;
	char	*relname;
	char	table_name[256];

	if (pgr_state == NULL || pgr_dep_hash == NULL)
		return;

	/*
	 * Look up the relation name for the log message.
	 * This must be done before the DROP executes.
	 */
	relname = get_rel_name(table_oid);
	if (relname != NULL)
		strlcpy(table_name, relname, sizeof(table_name));
	else
		snprintf(table_name, sizeof(table_name), "OID %u", table_oid);

	count = pgr_dep_find_by_table(table_oid, query_ids, 256);
	if (count == 0)
		return;

	{
		int		safe_count = Min(count, 256);

		for (i = 0; i < safe_count; i++)
		{
			Oid			tbl_oids[PGR_MAX_DEPS_PER_QUERY];
			int			num_tables;
			char		entry_mode = 'd';
			bool		found;
			int			j;
			char		dummy[1][PGR_QUERY_ID_LEN];

			/* Read mode under lock before removing (pointer invalid after release) */
			{
				char		find_key[PGR_HASHKEY_LEN];
				PgrDepEntry *e;
				bool		found_e;

				pgr_dep_format_key(find_key, sizeof(find_key), query_ids[i]);
				LWLockAcquire(pgr_state->lock, LW_SHARED);
				e = (PgrDepEntry *) hash_search(pgr_dep_hash, find_key, HASH_FIND, &found_e);
				if (found_e && e != NULL)
					entry_mode = e->mode;
				LWLockRelease(pgr_state->lock);
			}

			num_tables = pgr_dep_copy_tables(query_ids[i], tbl_oids,
											 PGR_MAX_DEPS_PER_QUERY);

			found = pgr_dep_remove(query_ids[i]);

			if (!found)
				continue;

			/* Drop snapshot table in delta mode */
			if (entry_mode == 'd')
				pgr_snapshot_drop(query_ids[i]);

			/* Remove per-query UPDATE triggers and check base trigger cleanup */
			for (j = 0; j < num_tables; j++)
			{
				int		remaining;

				pgr_remove_update_trigger(tbl_oids[j], query_ids[i]);

				remaining = pgr_dep_find_by_table(tbl_oids[j], dummy, 1);
				if (remaining == 0)
					pgr_remove_triggers(tbl_oids[j]);
			}
		}
	}

	if (reason != NULL)
		elog(WARNING,
			 "pg_reactive: auto-unsubscribed %d %s due to %s",
			 Min(count, 256),
			 count == 1 ? "query" : "queries",
			 reason);
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

		tupdesc = CreateTemplateTupleDesc(7);
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
		TupleDescInitEntry(tupdesc, (AttrNumber) 6, "mode",
						   TEXTOID, -1, 0);
		TupleDescInitEntry(tupdesc, (AttrNumber) 7, "audience",
						   JSONBOID, -1, 0);

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

	/*
	 * The shmem hash is shared across the cluster; skip entries owned by
	 * other databases so each database sees only its own subscriptions.
	 */
	while ((entry = (PgrDepEntry *) hash_seq_search(seq)) != NULL &&
		   entry->dbid != MyDatabaseId)
		;

	if (entry != NULL)
	{
		Datum		values[7];
		bool		nulls[7];
		HeapTuple	tuple;

		memset(nulls, 0, sizeof(nulls));
		values[0] = CStringGetTextDatum(entry->query_id);
		values[1] = CStringGetTextDatum(entry->query_text);
		values[2] = Int32GetDatum(entry->num_tables);
		values[3] = TimestampTzGetDatum(entry->subscribed_at);
		values[4] = Int64GetDatum(entry->invalidation_count);
		values[5] = CStringGetTextDatum(entry->mode == 'n' ? "notify" : "delta");

		if (entry->audience[0] == '\0')
			nulls[6] = true;
		else
			values[6] = DirectFunctionCall1(jsonb_in,
										   CStringGetDatum(entry->audience));

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
		funcctx->max_calls = 7;
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
			{
				/* per-database count (cluster-shared hash); lock held */
				HASH_SEQ_STATUS cnt_seq;
				PgrDepEntry *cnt_entry;
				long		active = 0;

				hash_seq_init(&cnt_seq, pgr_dep_hash);
				while ((cnt_entry = hash_seq_search(&cnt_seq)) != NULL)
				{
					if (cnt_entry->dbid == MyDatabaseId)
						active++;
				}
				values[0] = CStringGetTextDatum("active_subscriptions");
				snprintf(valbuf, sizeof(valbuf), "%ld", active);
				break;
			}
			case 1:
				values[0] = CStringGetTextDatum("max_subscriptions");
				snprintf(valbuf, sizeof(valbuf), "%d",
						 pgr_max_subscriptions);
				break;
			case 2:
				values[0] = CStringGetTextDatum("total_subscribes");
				snprintf(valbuf, sizeof(valbuf), INT64_FORMAT,
						 pgr_state->subscribe_count);
				break;
			case 3:
				values[0] = CStringGetTextDatum("total_unsubscribes");
				snprintf(valbuf, sizeof(valbuf), INT64_FORMAT,
						 pgr_state->unsubscribe_count);
				break;
			case 4:
				values[0] = CStringGetTextDatum("total_invalidations");
				snprintf(valbuf, sizeof(valbuf), INT64_FORMAT,
						 pgr_state->invalidation_count);
				break;
			case 5:
				values[0] = CStringGetTextDatum("total_evictions");
				snprintf(valbuf, sizeof(valbuf), INT64_FORMAT,
						 pgr_state->eviction_count);
				break;
			case 6:
				values[0] = CStringGetTextDatum("total_recomputes");
				snprintf(valbuf, sizeof(valbuf), INT64_FORMAT,
						 pgr_state->recompute_count);
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

	/* GUC: pg_reactive.batch_invalidation
	 * PGC_SUSET: only superusers can change. Using PGC_USERSET would allow
	 * mid-transaction toggling which silently drops notifications when the
	 * trigger marks dirty (batch path) but pre-commit sees batch=off. */
	DefineCustomBoolVariable("pg_reactive.batch_invalidation",
							 "Batch recomputes within a transaction",
							 "When enabled, DML triggers defer recompute to "
							 "transaction pre-commit, batching multiple DML "
							 "statements into a single recompute per query.",
							 &pgr_batch_invalidation,
							 true,		/* default on */
							 PGC_SUSET,
							 0,
							 NULL, NULL, NULL);

	/* GUC: pg_reactive.notify_channel */
	DefineCustomStringVariable("pg_reactive.notify_channel",
							   "NOTIFY channel name for pg_reactive notifications",
							   "All delta, overflow, and invalidation notifications are "
							   "sent on this LISTEN/NOTIFY channel. Default: \"pgr\".",
							   &pgr_notify_channel,
							   "pgr",		/* default */
							   PGC_SUSET,
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

	elog(LOG, "pg_reactive %s: loaded (max_subscriptions=%d, async_recompute=%s, batch_invalidation=%s, notify_channel=%s)",
		 PG_REACTIVE_VERSION, pgr_max_subscriptions,
		 pgr_async_recompute ? "on" : "off",
		 pgr_batch_invalidation ? "on" : "off",
		 pgr_notify_channel);
}
