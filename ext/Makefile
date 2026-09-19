MODULE_big = pg_reactive
OBJS = src/pg_reactive.o src/dependency.o src/invalidation.o src/recompute.o src/bgworker.o

EXTENSION = pg_reactive
DATA = pg_reactive--0.1.2.sql pg_reactive--0.1.1--0.1.2.sql pg_reactive--0.1.3.sql pg_reactive--0.1.2--0.1.3.sql pg_reactive--0.1.4.sql pg_reactive--0.1.3--0.1.4.sql pg_reactive--0.1.5.sql pg_reactive--0.1.4--0.1.5.sql pg_reactive--0.1.5--0.1.6.sql pg_reactive--0.1.6--0.1.7.sql pg_reactive--0.1.7--0.1.8.sql pg_reactive--0.1.8.sql

REGRESS = 00_setup 01_subscribe 02_invalidation 03_recompute 04_overflow 05_coverage 06_column_tracking 07_notify_mode 08_advanced_queries 09_batch_invalidation 10_audience 11_snapshot_drift 12_rollback_journal 13_extension_upgrade 14_generation 15_restore_privilege 16_recompute_role
REGRESS_OPTS = --dbname=pg_reactive_test

ISOLATION = concurrent_dml concurrent_subscribe concurrent_invalidation audience_visibility
ISOLATION_OPTS = --dbname=pg_reactive_test

PG_CPPFLAGS = -I$(srcdir)/src
PG_CFLAGS = -Wall -Werror

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)

# Alias: ISOLATION tests run as part of installcheck in PGXS (verified on
# PG 15 through 18). This target exists so CI can call it explicitly.
isolation_installcheck: installcheck
