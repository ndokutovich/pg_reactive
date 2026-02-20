#include "postgres.h"
#include "fmgr.h"
#include "utils/guc.h"

PG_MODULE_MAGIC;

void _PG_init(void);

void
_PG_init(void)
{
	elog(LOG, "pg_reactive %s: extension loaded", "0.1");
}
