#!/usr/bin/env bash
# PGXN packaging for the pg_reactive C extension (ext/).
#
#   scripts/pgxn-bundle.sh check        # version parity + consolidated-script freshness
#   scripts/pgxn-bundle.sh consolidate  # regenerate ext/pg_reactive--<V>.sql from the chain
#   scripts/pgxn-bundle.sh bundle       # check + git archive -> dist/pg_reactive-<V>.zip
#
# The consolidated install script is the base script + every later upgrade
# script concatenated in chain order — byte-equivalent to what CREATE
# EXTENSION applies via the upgrade path. CI runs `check`; a new upgrade
# script therefore cannot land without regenerating the consolidated file
# (same discipline as cli/dist parity).
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-check}"

CONTROL_V=$(sed -n "s/^default_version *= *'\(.*\)'/\1/p" ext/pg_reactive.control)
META_V=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('ext/META.json','utf8')).version)")
[ -n "$CONTROL_V" ] || { echo "FAIL: no default_version in pg_reactive.control"; exit 1; }
[ "$CONTROL_V" = "$META_V" ] || { echo "FAIL: version drift — control=$CONTROL_V META.json=$META_V"; exit 1; }

# chain order is fixed: base 0.1.5, then each upgrade up to CONTROL_V
BASE=ext/pg_reactive--0.1.5.sql
UPGRADES="ext/pg_reactive--0.1.5--0.1.6.sql ext/pg_reactive--0.1.6--0.1.7.sql ext/pg_reactive--0.1.7--0.1.8.sql"
OUT="ext/pg_reactive--$CONTROL_V.sql"
for f in $BASE $UPGRADES; do [ -f "$f" ] || { echo "FAIL: missing chain file $f"; exit 1; }; done

# Historic chain segments (0.1.5 base, 0.1.6 upgrade) define
# pgr.restore_subscriptions as SECURITY DEFINER — the shape the 0.1.7 upgrade
# replaced with SECURITY INVOKER (invariant 18, lint SEC-R41). Inside the
# consolidated script those definitions are transient: CREATE EXTENSION runs
# the whole script in one atomic transaction, so the DEFINER shape never
# survives to a state anything can call (15_restore_privilege proves the final
# shape). Mark ONLY the historic segments; the final INVOKER redefinition in
# the 0.1.7+ segments stays unmarked so SEC-R41 keeps guarding it.
annotate_historic() {
    sed -E '/^CREATE (OR REPLACE )?FUNCTION pgr\.restore_subscriptions/ s/$/ -- lint:allow=SEC-R41 (transient: replaced by the INVOKER redefinition later in this same atomic script)/'
}

render() {
    printf -- '-- pg_reactive extension install script v%s\n' "$CONTROL_V"
    printf -- '-- GENERATED consolidated script: base 0.1.5 + upgrades 0.1.6, 0.1.7, 0.1.8\n'
    printf -- '-- concatenated in chain order (exactly what CREATE EXTENSION would apply\n'
    printf -- '-- via the upgrade path). Regenerate with scripts/pgxn-bundle.sh --consolidate\n'
    printf -- '-- whenever a new upgrade script lands; CI installcheck proves it standalone.\n'
    printf -- '\\echo Use "CREATE EXTENSION pg_reactive" to load this extension. \\quit\n\n'
    # base minus its own 2-line header (title + \echo guard)
    tail -n +3 "$BASE" | sed -e 's/\r$//' -e '1{/^$/d}' | annotate_historic
    for up in $UPGRADES; do
        printf -- '\n-- \xe2\x95\x90\xe2\x95\x90\xe2\x95\x90 %s \xe2\x95\x90\xe2\x95\x90\xe2\x95\x90\n' "$(basename "$up")"
        case "$up" in
          *--0.1.6.sql) sed -e 's/\r$//' "$up" | annotate_historic ;;
          *)            sed -e 's/\r$//' "$up" ;;
        esac
    done
}

case "$MODE" in
  consolidate|--consolidate)
    render > "$OUT"
    echo "regenerated $OUT ($(wc -l < "$OUT") lines)"
    ;;
  check|--check)
    render | diff -u <(sed 's/\r$//' "$OUT") - >/dev/null \
      || { echo "FAIL: $OUT is stale — run scripts/pgxn-bundle.sh consolidate"; exit 1; }
    grep -q "pg_reactive--$CONTROL_V.sql" ext/Makefile \
      || { echo "FAIL: pg_reactive--$CONTROL_V.sql missing from ext/Makefile DATA"; exit 1; }
    echo "OK: control=$CONTROL_V == META.json; consolidated script fresh; in DATA"
    ;;
  bundle|--bundle)
    "$0" check
    mkdir -p dist
    ZIP="dist/pg_reactive-$CONTROL_V.zip"
    # git archive of the ext/ subtree: tracked files only (no .so/.o/.bc
    # build litter), repo-normalized LF endings regardless of host OS.
    git ls-tree --name-only HEAD:ext | grep -qx "META.json" \
      || { echo "FAIL: ext/META.json is not committed — the archive ships tracked files only"; exit 1; }
    git archive --format=zip --prefix="pg_reactive-$CONTROL_V/" -o "$ZIP" HEAD:ext
    echo "bundled $ZIP ($(du -h "$ZIP" | cut -f1))"
    ;;
  *)
    echo "usage: $0 [check|consolidate|bundle]"; exit 2
    ;;
esac
