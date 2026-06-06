MODULE_big = pg_reactive
OBJS = src/pg_reactive.o src/dependency.o src/invalidation.o src/recompute.o src/bgworker.o

EXTENSION = pg_reactive
DATA = pg_reactive--0.1.2.sql pg_reactive--0.1.1--0.1.2.sql pg_reactive--0.1.3.sql pg_reactive--0.1.2--0.1.3.sql pg_reactive--0.1.4.sql pg_reactive--0.1.3--0.1.4.sql

REGRESS = 00_setup 01_subscribe 02_invalidation 03_recompute 04_overflow 05_coverage 06_column_tracking 07_notify_mode 08_advanced_queries 09_batch_invalidation 10_audience 11_snapshot_drift
REGRESS_OPTS = --dbname=pg_reactive_test

ISOLATION = concurrent_dml concurrent_subscribe concurrent_invalidation
ISOLATION_OPTS = --dbname=pg_reactive_test

PG_CPPFLAGS = -I$(srcdir)/src
PG_CFLAGS = -Wall -Werror

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)

# Alias: isolation tests are already part of installcheck in PGXS 16+.
# This target exists so CI can call it explicitly without error.
isolation_installcheck: installcheck
