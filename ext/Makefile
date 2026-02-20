MODULE_big = pg_reactive
OBJS = src/pg_reactive.o src/dependency.o

EXTENSION = pg_reactive
DATA = pg_reactive--0.1.sql

REGRESS = 00_setup 01_subscribe
REGRESS_OPTS = --dbname=pg_reactive_test

PG_CPPFLAGS = -I$(srcdir)/src
PG_CFLAGS = -Wall -Werror

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)
