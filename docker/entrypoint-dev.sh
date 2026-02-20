#!/bin/bash
set -e

# Build and install the extension before starting PostgreSQL
if [ -f /ext/ext/Makefile ]; then
    echo "pg_reactive: building extension..."
    make -C /ext/ext clean 2>/dev/null || true
    make -C /ext/ext
    make -C /ext/ext install
    echo "pg_reactive: extension installed"
fi

# Delegate to the official postgres entrypoint
exec docker-entrypoint.sh "$@"
